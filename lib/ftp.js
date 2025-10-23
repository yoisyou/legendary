var fs = require('fs'),
    tls = require('tls'),
    Socket = require('net').Socket,
    EventEmitter = require('events').EventEmitter,
    inherits = require('util').inherits,
    XRegExp = require('xregexp').XRegExp;

var reXListUnix = XRegExp.cache('^(?<type>[\\-ld])(?<permission>([\\-r][\\-w][\\-xs]){3})\\s+(?<inodes>\\d+)\\s+(?<owner>\\w+)\\s+(?<group>\\w+)\\s+(?<size>\\d+)\\s+(?<timestamp>((?<month1>\\w{3})\\s+(?<date1>\\d{1,2})\\s+(?<hour>\\d{1,2}):(?<minute>\\d{2}))|((?<month2>\\w{3})\\s+(?<date2>\\d{1,2})\\s+(?<year>\\d{4})))\\s+(?<name>.+)$'),
    reXListMSDOS = XRegExp.cache('^(?<month>\\d{2})(?:\\-|\\/)(?<date>\\d{2})(?:\\-|\\/)(?<year>\\d{2,4})\\s+(?<hour>\\d{2}):(?<minute>\\d{2})\\s{0,1}(?<ampm>[AaMmPp]{1,2})\\s+(?:(?<size>\\d+)|(?<isdir>\\<DIR\\>))\\s+(?<name>.+)$'),
    reXTimeval = XRegExp.cache('^(?<year>\\d{4})(?<month>\\d{2})(?<date>\\d{2})(?<hour>\\d{2})(?<minute>\\d{2})(?<second>\\d+)$'),
    rePASV = /([\d]+),([\d]+),([\d]+),([\d]+),([-\d]+),([-\d]+)/,
    reEOL = /\r?\n/g,
    reResEnd = /(?:^|\r?\n)(\d{3}) [^\r\n]*\r?\n$/;/*,
    reRmLeadCode = /(^|\r?\n)\d{3}(?: |\-)/g;*/

var MONTHS = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    },
    TYPE = {
      SYNTAX: 0,
      INFO: 1,
      SOCKETS: 2,
      AUTH: 3,
      UNSPEC: 4,
      FILESYS: 5
    },
    RETVAL = {
      PRELIM: 1,
      OK: 2,
      WAITING: 3,
      ERR_TEMP: 4,
      ERR_PERM: 5
    },
    /*ERRORS = {
      421: 'Service not available, closing control connection',
      425: 'Can\'t open data connection',
      426: 'Connection closed; transfer aborted',
      450: 'Requested file action not taken / File unavailable (e.g., file busy)',
      451: 'Requested action aborted: local error in processing',
      452: 'Requested action not taken / Insufficient storage space in system',
      500: 'Syntax error / Command unrecognized',
      501: 'Syntax error in parameters or arguments',
      502: 'Command not implemented',
      503: 'Bad sequence of commands',
      504: 'Command not implemented for that parameter',
      530: 'Not logged in',
      532: 'Need account for storing files',
      550: 'Requested action not taken / File unavailable (e.g., file not found, no access)',
      551: 'Requested action aborted: page type unknown',
      552: 'Requested file action aborted / Exceeded storage allocation (for current directory or dataset)',
      553: 'Requested action not taken / File name not allowed'
    },*/
    bytesCRLF = new Buffer([13, 10]),
    bytesNOOP = new Buffer('NOOP\r\n');

var FTP = module.exports = function() {
  this._socket = undefined;
  this._pasvSock = undefined;
  this._feat = undefined;
  this._curReq = undefined;
  this._queue = [];
  this._buffer = '';
  this._secstate = undefined;
  this._debug = undefined;
  this.options = {
    host: undefined,
    port: undefined,
    user: undefined,
    password: undefined,
    secure: false,
    connTimeout: undefined,
    pasvTimeout: undefined,
    keepalive: undefined
  };
  this.connected = false;
};
inherits(FTP, EventEmitter);

FTP.prototype.connect = function(options) {
  var self = this;
  if (typeof options !== 'object')
    options = {};
  this.connected = false;
  this.options.host = options.host || 'localhost';
  this.options.port = options.port || 21;
  this.options.user = options.user || 'anonymous';
  this.options.password = options.password || 'anonymous@';
  this.options.secure = options.secure || false;
  this.options.connTimeout = options.connTimeout || 10000;
  this.options.pasvTimeout = options.pasvTimeout || 10000;
  this.options.keepalive = options.keepalive || 10000;
  if (typeof options.debug === 'function')
    this._debug = options.debug;

  var socket = this._socket = new Socket();

  this._socket.setTimeout(0);
  if (this.options.secure === 'implicit')
    socket = tls.connect({ socket: this._socket }, onconnect);
  else
    this._socket.once('connect', onconnect);

  var timer = setTimeout(function() {
    self.emit('error', new Error('Timeout while connecting to server'));
    self._socket.destroy();
    self._reset();
  }, this.options.connTimeout);

  var keepalive,
      noopreq = {
        cmd: 'NOOP',
        cb: function() {
          keepalive = setTimeout(donoop, self.options.keepalive);
        }
      };

  function donoop() {
    if (!self._socket || !self._socket.writable)
      clearTimeout(keepalive);
    else if (!self._curReq && self._queue.length === 0) {
      self._curReq = noopreq;
      self._socket.write(bytesNOOP);
    } else
      keepalive = setTimeout(donoop, self.options.keepalive);
  }

  function onconnect() {
    clearTimeout(timer);
    clearTimeout(keepalive);
    self.connected = true;
    self._socket = socket; // re-assign for implicit secure connections

    var cmd;

    if (self._secstate) {
      if (self._secstate === 'upgraded-tls' && self.options.secure === true) {
        cmd = 'PBSZ';
        self._send('PBSZ 0', reentry, true);
      } else {
        cmd = 'USER';
        self._send('USER ' + self.options.user, reentry, true);
      }
    } else {
      self._curReq = {
        cmd: '',
        cb: reentry
      };
    }

    function reentry(err, text, code) {
      if (err && (!cmd || cmd === 'USER' || cmd === 'PASS' || cmd === 'TYPE')) {
        self.emit('error', err);
        return self._socket.end();
      }
      if ((cmd === 'AUTH TLS' && code !== 234 && self.options.secure !== true)
          || (cmd === 'AUTH SSL' && code !== 334)
          || (cmd === 'PBSZ' && code !== 200)
          || (cmd === 'PROT' && code !== 200)) {
        self.emit('error', makeError('Unable to secure connection(s)', code));
        return self._socket.end();
      }

      if (!cmd) {
        // sometimes the initial greeting can contain useful information
        // about authorized use, other limits, etc.
        self.emit('greeting', text);

        if (self.options.secure && self.options.secure !== 'implicit') {
          cmd = 'AUTH TLS';
          self._send(cmd, reentry, true);
        } else {
          cmd = 'USER';
          self._send('USER ' + self.options.user, reentry, true);
        }
      } else if (cmd === 'USER') {
        if (code === 331) {
          // password required
          if (!self.options.password) {
            self.emit('error', makeError('Password required', code));
            return self._socket.end();
          }
          cmd = 'PASS';
          self._send('PASS ' + self.options.password, reentry, true);
        } else {
          // no password required
          cmd = 'PASS';
          reentry(undefined, text, code);
        }
      } else if (cmd === 'PASS') {
        cmd = 'FEAT';
        self._send(cmd, reentry, true);
      } else if (cmd === 'FEAT') {
        if (!err)
          self._parseFeat(text);
        cmd = 'TYPE';
        self._send('TYPE I', reentry, true);
      } else if (cmd === 'TYPE') {
        donoop();
        self.emit('ready');
      } else if (cmd === 'PBSZ') {
        cmd = 'PROT';
        self._send('PROT P', reentry, true);
      } else if (cmd === 'PROT') {
        cmd = 'USER';
        self._send('USER ' + self.options.user, reentry, true);
      } else if (cmd.substr(0, 4) === 'AUTH') {
        if (cmd === 'AUTH TLS' && code !== 234) {
          cmd = 'AUTH SSL';
          return self._send(cmd, reentry, true);
        } else if (cmd === 'AUTH TLS')
          self._secstate = 'upgraded-tls';
        else if (cmd === 'AUTH SSL')
          self._secstate = 'upgraded-ssl';
        socket.removeAllListeners('data');
        socket._decoder = null;
        self._curReq = null; // prevent queue from being processed during
                             // TLS/SSL negotiation
        socket = tls.connect({ socket: self._socket }, onconnect);
        socket.setEncoding('binary');
        socket.on('data', ondata);
      }
    }
  };

  socket.setEncoding('binary');
  socket.on('data', ondata);
  function ondata(chunk) {
    console.dir(chunk);
    self._buffer += chunk;
    var m;
    if (m = reResEnd.exec(self._buffer)) {
      var code, retval, reRmLeadCode;
      // we have a terminating response line
      code = parseInt(m[1], 10);
      reEOL.lastIndex = 0;
      //var isML = (reEOL.test(self._buffer) && reEOL.test(self._buffer));
      reEOL.lastIndex = 0;
      retval = code / 100 >> 0;

      // RFC 959 does not require each line in a multi-line response to begin
      // with '<code>-', but many servers will do this.
      //
      // remove this leading '<code>-' (or '<code> ' from last line) from each
      // line in the response ...
      reRmLeadCode = '(^|\\r?\\n)';
      reRmLeadCode += m[1];
      reRmLeadCode += '(?: |\\-)';
      reRmLeadCode = RegExp(reRmLeadCode, 'g');
      self._buffer = self._buffer.replace(reRmLeadCode, '$1').trim();

      if (retval === RETVAL.ERR_TEMP || retval === RETVAL.ERR_PERM)
        self._curReq.cb(makeError(self._buffer, code));
      else
        self._curReq.cb(undefined, self._buffer, code);
      self._buffer = '';

      // a hack to signal we're waiting for a PASV data connection to complete
      // first before executing any more queued requests ...
      //
      // also: don't forget our current request if we're expecting another
      // terminating response ....
      if (self._curReq && retval !== RETVAL.PRELIM) {
        self._curReq = undefined;
        self._send();
      }
    }
  };

  this._socket.once('error', function(err) {
    clearTimeout(timer);
    clearTimeout(keepalive);
    self.emit('error', err);
  });

  var hasReset = false;
  this._socket.once('end', function() {
    ondone();
    self.emit('end');
  });

  this._socket.once('close', function(had_err) {
    ondone();
    self.emit('close', had_err);
  });

  function ondone() {
    if (!hasReset) {
      hasReset = true;
      clearTimeout(timer);
      clearTimeout(keepalive);
      self.connected = false;
      self._reset();
    }
  }

  this._socket.connect(this.options.port, this.options.host);
};

FTP.prototype.end = function() {
  if (this._socket && this._socket.writable)
    this._socket.end();
  if (this._pasvSock && this._pasvSock.writable)
    this._pasvSock.end();

  this._socket = undefined;
  this._pasvSock = undefined;
};

// "Standard" (RFC 959) commands
FTP.prototype.abort = function(immediate, cb) {
  if (typeof immediate === 'function') {
    cb = immediate;
    immediate = true;
  }
  if (immediate)
    this._send('ABOR', cb, true);
  else
    this._send('ABOR', cb);
};

FTP.prototype.cwd = function(path, cb) {
  this._send('CWD ' + path, cb);
};

FTP.prototype.delete = function(path, cb) {
  this._send('DELE' + path, cb);
};

FTP.prototype.status = function(cb) {
  this._send('STAT', cb);
};

FTP.prototype.rename = function(from, to, cb) {
  var self = this;
  this._send('RNFR' + from, function(err) {
    if (err)
      return cb(err);

    self._send('RNTO ' + to, cb);
  });
};

FTP.prototype.list = function(path, cb) {
  var self = this, cmd;

  if (typeof path === 'function') {
    cb = path;
    path = undefined;
    cmd = 'LIST';
  } else
    cmd = 'LIST ' + path;

  this._pasv(function(err, sock) {
    if (err)
      return cb(err);

    if (self._queue[0] && self._queue[0].cmd === 'ABOR')
      return cb();

    var sockerr, done = false, replies = 0, entries, buffer = '';

    sock.setEncoding('binary');
    sock.on('data', function(chunk) {
      buffer += chunk;
    });
    sock.once('error', function(err) {
      if (!sock.aborting)
        sockerr = err;
    });
    sock.once('end', ondone);
    sock.once('close', ondone);

    function ondone() {
      done = true;
      final();
    }
    function final() {
      if (done && replies === 2) {
        if (sockerr)
          return cb(new Error('Unexpected data connection error: ' + sockerr));
        if (sock.aborting)
          return cb();

        // process received data
        entries = buffer.split(reEOL);
        entries.pop(); // ending EOL
        for (var i = 0, len = entries.length; i < len; ++i)
          entries[i] = parseListEntry(entries[i]);
        cb(undefined, entries);
      }
    }

    // this callback will be executed multiple times, the first is when server
    // replies with 150 and then a final reply to indicate whether the transfer
    // was actually a success or not
    self._send(cmd, function(err, text, code) {
      if (err)
        return cb(err);

      // some servers may not open a data connection for empty directories
      if (++replies === 1 && code === 226) {
        replies = 2;
        sock.destroy();
        final();
      } else if (replies === 2)
        final();
    });
  });
};

FTP.prototype.get = function(path, cb) {
  var self = this;
  this._pasv(function(err, sock) {
    if (err)
      return cb(err);

    if (self._queue[0] && self._queue[0].cmd === 'ABOR')
      return cb();

    // modify behavior of socket events so that we can emit 'error' once for
    // either a TCP-level error OR an FTP-level error response that we get when
    // the socket is closed (e.g. the server ran out of space).
    var sockerr, started = false, lastreply = false, done = false;
    sock._emit = sock.emit;
    sock.emit = function(ev, arg1) {
      if (ev === 'error') {
        sockerr = err;
        return;
      } else if (ev === 'end' || ev === 'close') {
        if (!done) {
          done = true;
          ondone();
        }
        return;
      }
      sock._emit.apply(sock, Array.prototype.slice.call(arguments));
    };

    function ondone() {
      if (done && lastreply) {
        sock._emit('end');
        sock._emit('close');
      }
    }

    sock.pause();

    // this callback will be executed multiple times, the first is when server
    // replies with 150, then a final reply after the data connection closes
    // to indicate whether the transfer was actually a success or not
    self._send('RETR ' + path, function(err, text, code) {
      if (sockerr || err) {
        if (!started)
          cb(sockerr || err);
        else {
          sock._emit('error', sockerr || err);
          sock._emit('close', true);
        }
        return;
      }
      if (code === 150) {
        started = true;
        cb(undefined, sock);
        sock.resume();
      } else {
        lastreply = true;
        ondone();
      }
    });
  });
};

FTP.prototype.put = function(input, path, cb) {
  this._store('STOR ' + path, input, cb);
};

FTP.prototype.append = function(input, path, cb) {
  this._store('APPE ' + path, input, cb);
};

FTP.prototype.pwd = function(cb) { // PWD is optional
  this._send('PWD', function(err, text) {
    if (err)
      return cb(err);
    cb(undefined, /^"(.+)"(?: |$)/.exec(text)[1]);
  });
};

FTP.prototype.cdup = function(cb) { // CDUP is optional
  this._send('CDUP', cb);
};

FTP.prototype.mkdir = function(path, cb) { // MKD is optional
  this._send('MKD ' + path, cb);
};

FTP.prototype.rmdir = function(path, cb) { // RMD is optional
  this._send('RMD ' + path, cb);
};

FTP.prototype.system = function(cb) { // SYST is optional
  this._send('SYST', function(err, text) {
    if (err)
      return cb(err);
    cb(undefined, /^([^ ]+)(?: |$)/.exec(text)[1]);
  });
};

// "Extended" (RFC 3659) commands
FTP.prototype.size = function(path, cb) {
  this._send('SIZE ' + path, function(err, text) {
    if (err)
      return cb(err);
    cb(undefined, parseInt(text, 10));
  });
};

FTP.prototype.lastMod = function(path, cb) {
  this._send('MDTM ' + path, function(err, text, code) {
    if (err)
      return cb(err);
    var val = XRegExp.exec(text, reXTimeval), ret;
    if (!val)
      return cb(new Error('Invalid date/time format from server'));
    // seconds can be a float, we'll just truncate this because Date doesn't
    // support fractions of a second
    var secs = parseInt(val.second, 10);
    ret = new Date(val.year + '-' + val.month + '-' + val.date + 'T' + val.hour
                   + ':' + val.minute + ':' + secs);
    cb(undefined, ret);
  });
};

FTP.prototype.restart = function(offset, cb) {
  this._send('REST ' + offset, cb);
};



// Private/Internal methods
FTP.prototype._parseFeat = function(text) {
  var lines = text.split(reEOL);
  lines.shift(); // initial response line
  lines.pop(); // final response line

  for (var i = 0, len = lines.length; i < len; ++i)
    lines[i] = lines[i].trim();

  // just store the raw lines for now
  this._feat = lines;
};

FTP.prototype._pasv = function(cb) {
  var self = this, first = true, ip, port;
  this._send('PASV', function reentry(err, text) {
    if (err)
      return cb(err);

    self._curReq = undefined;

    if (first) {
      var m = rePASV.exec(text);
      if (!m)
        return cb(new Error('Unable to parse PASV server response'));
      ip = m[1];
      ip += '.';
      ip += m[2];
      ip += '.';
      ip += m[3];
      ip += '.';
      ip += m[4];
      port = (parseInt(m[5], 10) * 256) + parseInt(m[6], 10);

      first = false;
    }
    self._pasvConnect(ip, port, function(err, sock) {
      if (err) {
        // try the IP of the control connection if the server was somehow
        // misconfigured and gave for example a LAN IP instead of WAN IP over
        // the Internet
        if (ip !== self._socket.remoteAddress) {
          ip = self._socket.remoteAddress;
          return reentry();
        }

        // automatically abort PASV mode
        self._send('ABOR', function() {
          cb(err);
          self._send();
        }, true);

        return;
      }
      cb(undefined, sock);
      self._send();
    });
  });
};

FTP.prototype._pasvConnect = function(ip, port, cb) {
  var self = this,
      socket = new Socket(), ssocket,
      sockerr,
      timedOut = false,
      timer = setTimeout(function() {
        timedOut = true;
        ssocket.destroy();
        cb(new Error('Timed out while making data connection'));
      }, this.options.pasvTimeout);

  socket.setTimeout(0);

  if (self.options.secure === true)
    ssocket = tls.connect({ socket: socket }, onconnect);
  else {
    socket.once('connect', onconnect);
    ssocket = socket;
  }
  function onconnect() {
    clearTimeout(timer);
    self._pasvSocket = ssocket;
    cb(undefined, ssocket);
  };
  socket.once('error', function(err) {
    sockerr = err;
  });
  socket.once('end', function() {
    clearTimeout(timer);
  });
  socket.once('close', function(had_err) {
    clearTimeout(timer);
    if (!self._pasvSocket && !timedOut) {
      var errmsg = 'Unable to make data connection';
      if (sockerr) {
        errmsg += ': ' + sockerr;
        sockerr = undefined;
      }
      cb(new Error(errmsg));
    }
    self._pasvSocket = undefined;
  });

  socket.connect(port, ip);
};

FTP.prototype._store = function(cmd, input, cb) {
  var isBuffer = Buffer.isBuffer(input);

  if (!isBuffer && input.pause !== undefined)
    input.pause();

  var self = this;
  this._pasv(function(err, sock) {
    if (err)
      return cb(err);

    if (self._queue[0] && self._queue[0].cmd === 'ABOR')
      return cb();

    var sockerr;
    sock.once('error', function(err) {
      sockerr = err;
    });

    // this callback will be executed multiple times, the first is when server
    // replies with 150, then a final reply after the data connection closes
    // to indicate whether the transfer was actually a success or not
    self._send(cmd, function(err, text, code) {
      if (sockerr || err)
        return cb(sockerr || err);

      if (code === 150) {
        if (isBuffer)
          sock.end(input);
        else if (typeof input === 'string') {
          // check if input is a file path or just string data to store
          fs.stat(input, function(err, stats) {
            if (err)
              sock.end(input);
            else
              fs.createReadStream(input).pipe(sock);
          });
        } else {
          input.pipe(sock);
          input.resume();
        }
      } else
        cb();
    });
  });
};

FTP.prototype._send = function(cmd, cb, promote) {
  if (cmd !== undefined) {
    if (promote)
      this._queue.unshift({ cmd: cmd, cb: cb });
    else
      this._queue.push({ cmd: cmd, cb: cb });
  }
  if (!this._curReq && this._queue.length) {
    this._curReq = this._queue.shift();
    if (this._curReq.cmd === 'ABOR' && this._pasvSocket)
      this._pasvSocket.aborting = true;
    this._socket.write(this._curReq.cmd);
    this._socket.write(bytesCRLF);
  }
};

FTP.prototype._reset = function() {
  if (this._socket && this._socket.writable)
    this._socket.end();
  if (this._socket && this._socket.connTimer)
    clearTimeout(this._socket.connTimer);
  if (this._socket && this._socket.keepalive)
    clearInterval(this._socket.keepalive);
  this._socket = undefined;
  this._pasvSock = undefined;
  this._feat = undefined;
  this._curReq = undefined;
  this._secstate = undefined;
  this._queue = [];
  this._buffer = '';
  this.options.host = this.options.port = this.options.user
                    = this.options.password = this.options.secure
                    = this.options.connTimeout = this.options.pasvTimeout
                    = this.options.keepalive = this._debug = undefined;
  this.connected = false;
};

// Utility functions
function parseListEntry(line) {
  var ret,
      info,
      month,
      day,
      year,
      hour,
      mins;

  if (ret = XRegExp.exec(line, reXListUnix)) {
    info = {
      type: ret.type,
      name: undefined,
      target: undefined,
      rights: {
        user: ret.permission.substring(0, 3).replace('-', ''),
        group: ret.permission.substring(3, 6).replace('-', ''),
        other: ret.permission.substring(6, 9).replace('-', '')
      },
      owner: ret.owner,
      group: ret.group,
      size: parseInt(ret.size, 10),
      date: undefined
    };
    if (ret.month1 !== undefined) {
      month = parseInt(MONTHS[ret.month1.toLowerCase()], 10);
      day = parseInt(ret.date1, 10);
      year = (new Date()).getFullYear();
      hour = parseInt(ret.hour, 10);
      mins = parseInt(ret.minute, 10);
      if (month < 10)
        month = '0' + month;
      if (day < 10)
        day = '0' + day;
      if (hour < 10)
        hour = '0' + hour;
      if (mins < 10)
        mins = '0' + mins;
      info.date = new Date(year + '-' + month + '-' + day
                           + 'T' + hour + ':' + mins);
    } else if (ret.month2 !== undefined) {
      month = parseInt(MONTHS[ret.month2.toLowerCase()], 10);
      day = parseInt(ret.date2, 10);
      year = parseInt(ret.year, 10);
      if (month < 10)
        month = '0' + month;
      if (day < 10)
        day = '0' + day;
      info.date = new Date(year + '-' + month + '-' + day);
    }
    if (ret.type === 'l') {
      var pos = ret.name.indexOf(' -> ');
      info.name = ret.name.substring(0, pos);
      info.target = ret.name.substring(pos+4);
    } else
      info.name = ret.name;
    ret = info;
  } else if (ret = XRegExp.exec(line, reXListMSDOS)) {
    info = {
      name: ret.name,
      type: (ret.isdir ? 'd' : '-'),
      size: (ret.isdir ? 0 : parseInt(ret.size, 10)),
      date: undefined,
    };
    month = parseInt(ret.month, 10),
    day = parseInt(ret.date, 10),
    year = parseInt(ret.year, 10),
    hour = parseInt(ret.hour, 10),
    mins = parseInt(ret.minute, 10);

    if (ret.ampm[0].toLowerCase() === 'p' && hour < 12)
      hour += 12;
    else if (ret.ampm[0].toLowerCase() === 'a' && hour === 12)
      hour = 0;

    if (month < 10)
      month = '0' + month;
    if (day < 10)
      day = '0' + day;
    if (hour < 10)
      hour = '0' + hour;
    if (mins < 10)
      mins = '0' + mins;

    info.date = new Date(year + '-' + month + '-' + day
                         + 'T' + hour + ':' + mins);
    ret = info;
  } else
    ret = line; // could not parse, so at least give the end user a chance to
                // look at the raw listing themselves

  return ret;
}

function makeError(msg, code) {
  var err = new Error(msg);
  err.code = code;
  return err;
}
