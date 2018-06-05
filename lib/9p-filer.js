// -------------------------------------------------
// --------------------- 9P ------------------------
// -------------------------------------------------
// Implementation of the 9p filesystem wrapping Filer.js
// based on https://github.com/copy/v86/blob/master/lib/9p.js
// which in turn is based on 9P2000.L protocol:
// https://code.google.com/p/diod/wiki/protocol
// See also:
//   https://web.archive.org/web/20170601065335/http://plan9.bell-labs.com/sys/man/5/INDEX.html
//   https://github.com/chaos/diod/blob/master/protocol.md

"use strict";

// statfs filesystem f_type
// http://man7.org/linux/man-pages/man2/statfs.2.html
var V9FS_MAGIC = 0x01021997;

/**
 * 9P message types
 * https://github.com/chaos/diod/blob/7ee44ff840138d45158e7ae1f296c9e82292fa7f/libnpfs/9p.h#L43
 */
const P9_TSTATFS = 8; // file system status request
const P9_TLOPEN = 12;
const P9_TLCREATE = 14; // prepare a handle for I/O on an new file for 9P2000.L
const P9_TSYMLINK = 16; // make symlink request
const P9_TMKNOD = 18; // create a special file object request
const P9_TREADLINK = 22; // 
const P9_TGETATTR = 24;
const P9_TSETATTR = 26;
const P9_TXATTRWALK = 30
const P9_TXATTRCREATE = 32;
const P9_TREADDIR = 40;
const P9_TFSYNC = 50;
const P9_TLOCK = 52;
const P9_TGETLOCK = 54;
const P9_TLINK = 70;
const P9_TMKDIR = 72; // create a directory request
const P9_TRENAMEAT = 74;
const P9_TUNLINKAT = 76;
const P9_TVERSION = 100; // version handshake request
const P9_TATTACH = 104; // establish user access to file service
const P9_TERROR = 106; // not used
const P9_TFLUSH = 108; // request to abort a previous request
const P9_TWALK = 110; // descend a directory hierarchy
const P9_TOPEN = 112; // prepare a handle for I/O on an existing file
const P9_TREAD = 116; // request to transfer data from a file or directory
const P9_TWRITE = 118; // request to transfer data to a file
const P9_TCLUNK = 120; // forget about a handle to an entity within the file system
/**
 * Currently Not Used below
 * TODOhumphd: do we need any of these?
 */
const P9_TRENAME = 20; // rename request
const P9_TAUTH = 102; // request to establish authentication channel
const P9_TCREATE = 114; // prepare a handle for I/O on a new file
const P9_TREMOVE = 122; // request to remove an entity from the hierarchy
const P9_TSTAT = 124; // request file entity attributes
const P9_TWSTAT = 126; // request to update file entity attributes

// Mapping of Filer node.js errors to POSIX (errno.h)
const POSIX_ERR_CODE_MAP = {
    'EPERM': 1,
    'ENOENT': 2,
    'EBADF': 9,
    'EBUSY': 11,
    'EINVAL': 22,
    'ENOTDIR': 20,
    'EISDIR': 21,
    'EEXIST': 17,
    'ELOOP': 40,
    'ENOTEMPTY': 39,
    'EIO': 5
};

var P9_SETATTR_MODE = 0x00000001;
var P9_SETATTR_UID = 0x00000002;
var P9_SETATTR_GID = 0x00000004;
var P9_SETATTR_SIZE = 0x00000008;
var P9_SETATTR_ATIME = 0x00000010;
var P9_SETATTR_MTIME = 0x00000020;
var P9_SETATTR_CTIME = 0x00000040;
var P9_SETATTR_ATIME_SET = 0x00000080;
var P9_SETATTR_MTIME_SET = 0x00000100;

var P9_STAT_MODE_DIR = 0x80000000;
var P9_STAT_MODE_APPEND = 0x40000000;
var P9_STAT_MODE_EXCL = 0x20000000;
var P9_STAT_MODE_MOUNT = 0x10000000;
var P9_STAT_MODE_AUTH = 0x08000000;
var P9_STAT_MODE_TMP = 0x04000000;
var P9_STAT_MODE_SYMLINK = 0x02000000;
var P9_STAT_MODE_LINK = 0x01000000;
var P9_STAT_MODE_DEVICE = 0x00800000;
var P9_STAT_MODE_NAMED_PIPE = 0x00200000;
var P9_STAT_MODE_SOCKET = 0x00100000;
var P9_STAT_MODE_SETUID = 0x00080000;
var P9_STAT_MODE_SETGID = 0x00040000;
var P9_STAT_MODE_SETVTX = 0x00010000;

/**
* QID types
*
* @P9_QTDIR: directory
* @P9_QTAPPEND: append-only
* @P9_QTEXCL: excluse use (only one open handle allowed)
* @P9_QTMOUNT: mount points
* @P9_QTAUTH: authentication file
* @P9_QTTMP: non-backed-up files
* @P9_QTSYMLINK: symbolic links (9P2000.u)
* @P9_QTLINK: hard-link (9P2000.u)
* @P9_QTFILE: normal files
*/
var P9_QTDIR = 0x80;
var P9_QTAPPEND = 0x40;
var P9_QTEXCL = 0x20;
var P9_QTMOUNT = 0x10;
var P9_QTAUTH = 0x08;
var P9_QTTMP = 0x04;
var P9_QTSYMLINK = 0x02;
var P9_QTLINK = 0x01;
var P9_QTFILE = 0x00;

var FID_NONE = -1;
var FID_INODE = 1;
var FID_XATTR = 2;

/**
 * https://web.archive.org/web/20170601072902/http://plan9.bell-labs.com/magic/man2html/5/0intro
 *
 * "The qid represents the server's unique identification for the file being
 * accessed: two files on the same server hierarchy are the same if and only
 * if their qids are the same. (The client may have multiple fids pointing to
 * a single file on a server and hence having a single qid.) The thirteen–byte
 * qid fields hold a one–byte type, specifying whether the file is a directory,
 * append–only file, etc., and two unsigned integers: first the four–byte qid
 * version, then the eight–byte qid path. The path is an integer unique among
 * all files in the hierarchy. If a file is deleted and recreated with the same
 * name in the same directory, the old and new path components of the qids
 * should be different. The version is a version number for a file; typically,
 * it is incremented every time the file is modified."
 */

// https://github.com/darkskyapp/string-hash
function hash32(string) {
    var hash = 5381;
    var i = string.length;

    while(i) {
        hash = (hash * 33) ^ string.charCodeAt(--i);
    }

    /* JavaScript does bitwise operations (like XOR, above) on 32-bit signed
    * integers. Since we want the results to be always positive, convert the
    * signed int to an unsigned by doing an unsigned bitshift. */
    return hash >>> 0;
}

function getQType(type) {
    switch(type) {
        case 'FILE':
            return P9_QTFILE;
        case 'DIRECTORY':
            return P9_QTDIR;
        case 'SYMLINK':
            return P9_QTSYMLINK;
        default:
            return P9_QTFILE;
    }
}

function formatQid(path, stats) {
    return {
        type: getQType(stats.type),
        version: stats.version,
        path: hash32(stats.node)
    };
}

/** 
 * @constructor 
 *
 * @param {FS} filesystem
 */
function Virtio9p(filesystem, bus) {
    /** @const @type {FS} */
    this.fs = filesystem.fs;
    this.sh = new this.fs.Shell();

    /** @const @type {BusConnector} */
    this.bus = bus;

    this.deviceid = 0x9; // 9p filesystem
    this.hostfeature = 0x1; // mountpoint
    //this.configspace = [0x0, 0x4, 0x68, 0x6F, 0x73, 0x74]; // length of string and "host" string
    //this.configspace = [0x0, 0x9, 0x2F, 0x64, 0x65, 0x76, 0x2F, 0x72, 0x6F, 0x6F, 0x74 ]; // length of string and "/dev/root" string

    this.configspace = new Uint8Array([0x6, 0x0, 0x68, 0x6F, 0x73, 0x74, 0x39, 0x70]); // length of string and "host9p" string
    this.VERSION = "9P2000.L";
    this.BLOCKSIZE = 8192; // Let's define one page.
    this.msize = 8192; // maximum message size
    this.replybuffer = new Uint8Array(this.msize*2); // Twice the msize to stay on the safe side
    this.replybuffersize = 0;

    this.fids = {};

    // Any inflight responses might get flushed before we complete the fs i/o.
    // This is a list of all valid inflight responses that can continue.
    // If any async i/o callback happens, and its pendingTag is missing, it can abort.
    // http://plan9.bell-labs.com/magic/man2html/5/flush
    this.pendingTags = {};
}

// Before we begin any async file i/o, mark the tag as being pending
Virtio9p.prototype.addTag = function(tag) {
    this.pendingTags[tag] = {};
};

// Flush an inflight async request
Virtio9p.prototype.flushTag = function(tag) {
    delete this.pendingTags[tag];
};

// Check to see if the current request's tag has been aborted.
Virtio9p.prototype.shouldAbortRequest = function(tag) {
    var shouldAbort = !this.pendingTags[tag];
    if(shouldAbort) {
        message.Debug("Request can be aborted tag=" + tag);
    }
    return shouldAbort;
};

Virtio9p.prototype.SendReply = function(x, y) {
    message.Debug("Unexpected call to SendReply on Virtio9p", x, y);
};

Virtio9p.prototype.get_state = function() {
    var state = [];

    state[0] = this.deviceid;
    state[1] = this.hostfeature;
    state[2] = this.configspace;
    state[3] = this.VERSION;
    state[4] = this.BLOCKSIZE;
    state[5] = this.msize;
    state[6] = this.replybuffer;
    state[7] = this.replybuffersize;
    state[8] = JSON.stringify(this.fids);

    return state;
};

Virtio9p.prototype.set_state = function(state) {
    this.deviceid = state[0];
    this.hostfeature = state[1];
    this.configspace = state[2];
    this.VERSION = state[3];
    this.BLOCKSIZE = state[4];
    this.msize = state[5];
    this.replybuffer = state[6];
    this.replybuffersize = state[7];
    this.fids = JSON.parse(state[8]);
};


/**
 * "fid: a 32–bit unsigned integer that the client uses to identify a
 * ``current file'' on the server. Fids are somewhat like file descriptors in a
 * user process, but they are not restricted to files open for I/O: directories
 * being examined, files being accessed by stat(2) calls, and so on -- all files
 * being manipulated by the operating system -- are identified by fids. Fids are
 * chosen by the client. All requests on a connection share the same fid space;
 * when several clients share a connection, the agent managing the sharing must
 * arrange that no two clients choose the same fid."
 */
Virtio9p.prototype.Createfid = function(path, type, uid) {
    return {path: path, type: type, uid: uid};
};

Virtio9p.prototype.Reset = function() {
    this.fids = {};
};

/**
 * "The type of an R–message will either be one greater than the type of the
 * corresponding T–message or Rerror, indicating that the request failed. In the
 * latter case, the ename field contains a string describing the reason for failure."
 */
Virtio9p.prototype.BuildReply = function(id, tag, payloadsize) {
    marshall.Marshall(["w", "b", "h"], [payloadsize+7, id+1, tag], this.replybuffer, 0);
    if ((payloadsize+7) >= this.replybuffer.length) {
        message.Debug("Error in 9p: payloadsize exceeds maximum length");
    }
    this.replybuffersize = payloadsize+7;
    
    // We're done with this request, remove tag from pending list
    this.flushTag(tag);    
};
Virtio9p.prototype.SendError = function (tag, err) {
    console.warn('ERROR REPLY', err);
    var errorcode = POSIX_ERR_CODE_MAP[err.code];
    var size = marshall.Marshall(["w"], [errorcode], this.replybuffer, 7);
    this.BuildReply(6, tag, size);
};


Virtio9p.prototype.ReceiveRequest = function (index, GetByte) {
    var self = this;
    var header = marshall.Unmarshall2(["w", "b", "h"], GetByte);
    var size = header[0];
    var id = header[1];
    var tag = header[2];
    this.addTag(tag);

    var Filer = window.Filer;

    switch(id) {
        case P9_TSTATFS:
            message.Debug("[statfs]");

            // TODOhumphd: I'm not sure if I need/want to do accurate sizing info from indexeddb
            // See https://github.com/jonnysmith1981/getIndexedDbSize/blob/master/getIndexedDbSize.js
            var total_size = 50 * 1024; // this.fs.GetTotalSize(); // size used by all files
            var space = 256 * 1024 * 1024 * 1024; //this.fs.GetSpace();

            var f_type = V9FS_MAGIC;                            /* Type of filesystem */
            var f_bsize = this.BLOCKSIZE;                       /* Optimal transfer block size */
            var f_blocks = Math.floor(space/f_bsize);           /* Total data blocks in filesystem */
            var f_bfree = f_blocks - Math.floor(total_size/f_bsize);  /* Free blocks in filesystem */
            var f_bavail = f_blocks - Math.floor(total_size/f_bsize); /* Free blocks available to unprivileged user */
            var f_files = this.fs.inodes.length;                /* Total file nodes in filesystem */
            var f_ffree = 1024*1024;                            /* Free file nodes in filesystem */
            var f_fsid = 0;                                     /* Filesystem ID, "Nobody knows what f_fsid is supposed to contain" */
            var f_namelen = 256;                                /* Maximum length of filenames */

            var statfs = [
                f_type, f_bsize, f_blocks, f_bfree, f_bavail, f_files, f_ffree,
                f_fsid, f_namelen
            ];

            size = marshall.Marshall(["w", "w", "d", "d", "d", "d", "d", "d", "w"], statfs, this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(0, index);
            break;

        case P9_TLOPEN:
            var req = marshall.Unmarshall2(["w", "w"], GetByte);
            var fid = req[0];
            var path = this.fids[fid].path;
            var mode = req[1];

            message.Debug("[tlopen] fid=" + fid, " path=" + path, " mode=" + mode);

            self.fs.stat(path, function (err, stats) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                req[0] = formatQid(path, stats);
                req[1] = self.msize - 24;
                marshall.Marshall(["Q", "w"], req, self.replybuffer, 7);
                self.BuildReply(id, tag, 13+4);
                self.SendReply(0, index);
            });

            break;

        case P9_TLINK:
            var req = marshall.Unmarshall2(["w", "w", "s"], GetByte);
            var dfid = req[0];
            var dirPath = self.fids[dfid].path;
            var fid = req[1];
            var existingPath = self.fids[fid].path;
            var name = req[2];
            var newPath = Filer.Path.join(dirPath, name);

            message.Debug("[link] existingPath=" + existingPath + ", newPath=" + newPath);
            self.fs.link(existingPath, newPath, function(err) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                self.BuildReply(id, tag, 0);
                self.SendReply(0, index);
            });

            break;

        case P9_TSYMLINK:
            var req = marshall.Unmarshall2(["w", "s", "s", "w"], GetByte);
            var dfid = req[0];
            var dirPath = self.fids[dfid].path;
            var name = req[1];
            var newPath = Filer.Path.join(dirPath, name);
            var symtgt = req[2];
            // TODO: deal with gid
            var gid = req[3];

            message.Debug("[symlink] symtgt=" + symtgt +", newPath=" + newPath + ", gid=" + gid); 

            self.fs.symlink(symtgt, newPath, function(err) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                self.fs.stat(newPath, function(err, stats) {
                    if(self.shouldAbortRequest(tag)) return;

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }

                    var qid = formatQid(newPath, stats);

                    marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                    self.BuildReply(id, tag, 13);
                    self.SendReply(0, index);
                });
            });

            break;

        case P9_TMKNOD:
            var req = marshall.Unmarshall2(["w", "s", "w", "w", "w", "w"], GetByte);
            var dfid = req[0];
            var dirPath = self.fids[dfid].path;
            var name = req[1];
            var filePath = Filer.Path.join(dirPath, name);
            var mode = req[2];
            var major = req[3];
            var minor = req[4];
            var gid = req[5];
            message.Debug("[mknod] filePath=" + filePath + ", major=" + major + ", minor=" + minor + ", gid=" + gid);

            // TODO: need to deal with mode properly in Filer.
            self.fs.mknod(filePath, 'FILE', function(err) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                self.fs.stat(filePath, function(err, stats) {
                    if(self.shouldAbortRequest(tag)) return;

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }

                    var qid = formatQid(filePath, stats);

                    marshall.Marshall(["Q"], [qid], this.replybuffer, 7);
                    this.BuildReply(id, tag, 13);
                    this.SendReply(0, index);
                });
            });

            break;

        case P9_TREADLINK:
            var req = marshall.Unmarshall2(["w"], GetByte);
            var fid = req[0];
            var path = self.fids[fid].path;

            message.Debug("[readlink] path=" + path);

            self.fs.readlink(path, function(err, contents) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                size = marshall.Marshall(["s"], [contents], self.replybuffer, 7);
                self.BuildReply(id, tag, size);
                self.SendReply(0, index);    
            });

            break;

        case P9_TMKDIR:
            var req = marshall.Unmarshall2(["w", "s", "w", "w"], GetByte);
            var dfid = req[0];
            var name = req[1];
            var mode = req[2];
            var gid = req[3];
            var parentPath = self.fids[dfid].path;
            var newDir = Filer.Path.join(parentPath, name);

            message.Debug("[mkdir] fid.path=" + parentPath + ", name=" + newDir + ", mode=" + mode + ", gid=" + gid);

            self.fs.mkdir(newDir, function(err) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                self.fs.stat(newDir, function(err, stats) {
                    if(self.shouldAbortRequest(tag)) return;

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }

                    var qid = formatQid(newDir, stats);

                    marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                    self.BuildReply(id, tag, 13);
                    self.SendReply(0, index);
                });
            });

            break;

        case P9_TLCREATE:

            var req = marshall.Unmarshall2(["w", "s", "w", "w", "w"], GetByte);
            var fid = req[0];
            var name = req[1];
            var flags = req[2]; // TODO: I'm ignorning these right now.
            var mode = req[3];
            var gid = req[4];
            message.Debug("[tlcreate] fid=" + fid + ", name=" + name + ", mode=" + mode + ", gid=" + gid);

            var newFilePath = Filer.Path.join(self.fids[fid].path, name);

            // TODO: Deal with mode and gid
            self.fs.open(newFilePath, 'w', function(err, fd) {
                if(self.shouldAbortRequest(tag)) {
                    if(fd) self.fs.close(fd);
                    return;
                }

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }
                
                self.fs.fstat(fd, function(err, stats) {
                    if(self.shouldAbortRequest(tag)) {
                        if(fd) self.fs.close(fd);
                        return;
                    }
        
                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }

                    self.fids[fid] = self.Createfid(newFilePath, FID_INODE, uid);
                    self.fs.close(fd);
                    var qid = formatQid(newFilePath, stats);

                    marshall.Marshall(["Q", "w"], [qid, self.msize - 24], self.replybuffer, 7);
                    self.BuildReply(id, tag, 13+4);
                    self.SendReply(0, index);    
                });
            });

            break;

        case P9_TLOCK: // lock always succeeds
            message.Debug("lock file\n");
            marshall.Marshall(["w"], [0], this.replybuffer, 7);
            this.BuildReply(id, tag, 1);
            this.SendReply(0, index);
            break;

        /* TODO
        case P9_TGETLOCK:
            break;        
        */

        case P9_TGETATTR:
            var req = marshall.Unmarshall2(["w", "d"], GetByte);
            var fid = req[0];
            var request_mask = req[1];
            var path = this.fids[fid].path;

            message.Debug("[getattr]: fid=" + fid + " path=" + path + " request mask=" + req[1]);

            // We ignore the request_mask, and always send back all fields except btime, gen, data_version 
            function statsToFileAttributes(stats) {
                // P9_GETATTR_BASIC 0x000007ffULL - Mask for all fields except btime, gen, data_version */
                var valid = 0x000007ff;
                var qid = formatQid(path, stats);
                var mode = stats.mode;
                var uid = stats.uid;
                var gid = stats.gid;
                var nlink = stats.nlinks;
                var rdev = (0x0<<8) | (0x0);
                var size = stats.size;
                var blksize = self.BLOCKSIZE;
                var blocks = Math.floor(size/512+1);
                var atime_sec = Math.round(stats.atime / 1000);
                var atime_nsec = stats.atime * 1000000;
                var mtime_sec = Math.round(stats.mtime / 1000);
                var mtime_nsec = stats.mtime * 1000000;
                var ctime_sec = Math.round(stats.ctime / 1000);
                var ctime_nsec = stats.ctime * 1000000;
                // Reserved for future use, not supported by us.
                var btime_sec = 0x0;
                var btime_nsec = 0x0;
                var gen = 0x0;
                var data_version = 0x0;

                return [
                    valid, qid, mode, uid, gid, nlink, rdev, size, blksize,
                    blocks, atime_sec, atime_nsec, mtime_sec, mtime_nsec,
                    ctime_sec, ctime_nsec, btime_sec, btime_nsec, gen,
                    data_version
                ];
            }

            // Use lstat so we get proper symlink info
            self.fs.lstat(path, function (err, stats) {
                if(self.shouldAbortRequest(tag)) {
                    return;
                }

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                var p9Stats = statsToFileAttributes(stats);

                marshall.Marshall([
                    "d", "Q", 
                    "w",  
                    "w", "w", 
                    "d", "d", 
                    "d", "d", "d",
                    "d", "d",
                    "d", "d",
                    "d", "d",
                    "d", "d",
                    "d", "d",
                ], p9Stats, self.replybuffer, 7);
                self.BuildReply(id, tag, 8 + 13 + 4 + 4+ 4 + 8*15);
                self.SendReply(0, index);
            });

            break;

        case P9_TSETATTR:
            var req = marshall.Unmarshall2(["w", "w", 
                "w",      // mode 
                "w", "w", // uid, gid
                "d",      // size
                "d", "d", // atime_sec, atime_nsec
                "d", "d"] // mtime_sec, mtime_nsec
            , GetByte);
            var fid = req[0];
            var path = self.fids[fid].path;

            message.Debug("[setattr]: path=" + path + " request mask=" + req[1]);

            // TODO: need to convert Filer to use Promises and clean this up with async/await.
            var promises = [];

            if (req[1] & P9_SETATTR_MODE) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        var mode = req[2];

                        message.Debug("[setattr]: mode=" + mode);

                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }

                        self.fs.chmod(path, mode, function(err) {
                            if(err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    })
                );
            }

            // TODO: what if I only get one of uid/gid instead of both?
            if ((req[1] & P9_SETATTR_UID) && (req[1] & P9_SETATTR_GID)) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        var uid = req[3];
                        var gid = req[4];

                        message.Debug("[setattr]: uid=" + uid + " gid=" + gid);

                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }

                        self.fs.chown(path, uid, gid, function(err) {
                            if(err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    })
                );
            }

            var atime;
            var mtime;
            var now = Date.now();

            if (req[1] & P9_SETATTR_ATIME) {
                atime = now;
            }
            if (req[1] & P9_SETATTR_MTIME) {
                mtime = now;
            }
            // TODO: currently have no way to change CTIME via the Filer API.
            if (req[1] & P9_SETATTR_CTIME) {
                console.warn('[TODO] requested to SETATTR for CTIME, ignoring');
            }
            // TODO: need to confirm the unit for these times (sec vs nsec).
            if (req[1] & P9_SETATTR_ATIME_SET) {
                atime = req[6] * 1000; // assuming it will be sec, convert to ms
            }
            if (req[1] & P9_SETATTR_MTIME_SET) {
                mtime = req[8]* 1000; // assuming it will be sec, convert to ms
            }

            // TODO: deal with only having one of atime/mtime, currently assuming both
            if(atime || mtime) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }

                        message.Debug("[setattr]: atime=" + atime + " mtime=" + mtime);

                        self.fs.utimes(path, atime, mtime, function(err) {
                            if(err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    })
                );
            }

            if (req[1] & P9_SETATTR_SIZE) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        var size = req[5];

                        message.Debug("[setattr]: size=" + size);

                        self.fs.truncate(path, size, function(err) {
                            if(err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    })
                );
            }

            Promise
                .all(promises)
                .then(function() {
                    self.BuildReply(id, tag, 0);
                    self.SendReply(0, index);
                })
                .catch(function(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                });

            break;

        case P9_TFSYNC:
            var req = marshall.Unmarshall2(["w", "d"], GetByte);
            var fid = req[0];
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            break;

        case P9_TREADDIR:
            var req = marshall.Unmarshall2(["w", "d", "w"], GetByte);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = this.fids[fid].path;

            message.Debug("[treaddir]: fid=" + fid + " path=" + path + " offset=" + offset + " count=" + count);

            // Directory entries are represented as variable-length records:
            // qid[13] offset[8] type[1] name[s]
            self.sh.ls(path, {recursive: false} , function(err, entries) {
                if(self.shouldAbortRequest(tag)) {
                    return;
                }
                
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                // first get size
                var size = entries.reduce(function(currentValue, entry) {
                    return currentValue + 13 + 8 + 1 + 2 + UTF8.UTF8Length(entry.name);
                }, 0);

                // Deal with . and ..
                size += 13 + 8 + 1 + 2 + 1; // "." entry
                size += 13 + 8 + 1 + 2 + 2; // ".." entry
                var data = new Uint8Array(size);

                // Get info for '.'
                self.fs.stat(path, function(err, stats) {
                    if(self.shouldAbortRequest(tag)) {
                        return;
                    }
                    
                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }
                            
                    var dataOffset = 0x0;

                    dataOffset += marshall.Marshall(
                        ["Q", "d", "b", "s"],
                        [
                            formatQid(path, stats), 
                            dataOffset+13+8+1+2+1, 
                            stats.mode >> 12, 
                            "."
                        ],
                        data, dataOffset);
    
                    // Get info for '..'
                    var parentDirPath = Filer.Path.resolve("..", path);
                    self.fs.stat(parentDirPath, function(err, stats) {
                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }
    
                        if(err) {
                            self.SendError(tag, err);
                            self.SendReply(0, index);
                            return;
                        }
        
                        dataOffset += marshall.Marshall(
                            ["Q", "d", "b", "s"],
                            [
                                formatQid(parentDirPath, stats),
                                dataOffset+13+8+1+2+2, 
                                stats.mode >> 12, 
                                ".."
                            ],
                            data, dataOffset);
    
                        entries.forEach(function(entry) {
                            var entryPath = Filer.Path.join(path, entry.name);
                            dataOffset += marshall.Marshall(
                                ["Q", "d", "b", "s"],
                                [
                                    formatQid(entryPath, entry),
                                    dataOffset+13+8+1+2+UTF8.UTF8Length(entry.name),
                                    entry.mode >> 12,
                                    entry.name
                                ],
                                data, dataOffset);
                        });

                        if (size < offset+count) count = size - offset;
                        if(data) {
                            for(var i=0; i<count; i++)
                                self.replybuffer[7+4+i] = data[offset+i];
                        }

                        marshall.Marshall(["w"], [count], self.replybuffer, 7);
                        self.BuildReply(id, tag, 4 + count);
                        self.SendReply(0, index);
                    });
                });
            });

            break;

        case P9_TREAD:
            var req = marshall.Unmarshall2(["w", "d", "w"], GetByte);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = this.fids[fid].path;

            message.Debug("[tread]: fid=" + fid + " path=" + path + " offset=" + offset + " count=" + count);

/** TODO: Not sure about this...
            if (this.fids[fid].type == FID_XATTR) {
                if (inode.caps.length < offset+count) count = inode.caps.length - offset;
                for(var i=0; i<count; i++)
                    this.replybuffer[7+4+i] = inode.caps[offset+i];
                marshall.Marshall(["w"], [count], this.replybuffer, 7);
                this.BuildReply(id, tag, 4 + count);
                this.SendReply(0, index);
            }
 */

            function _read(data) {
                var size = data.length;

                // Don't trust `count`, use our own size info
                if(offset + count > size) {
                    count = size - offset;
                }

                for(var i=0; i<count; i++)
                    self.replybuffer[7+4+i] = data[offset+i];

                marshall.Marshall(["w"], [count], self.replybuffer, 7);
                self.BuildReply(id, tag, 4 + count);
                self.SendReply(0, index);
            }

            // Optimize such that we only get the data once, and cache it for the
            // lifetime of this request/response (i.e., on tag).
            var data = self.pendingTags[tag].data

            if(data) {
                _read(data);
                return;
            }

            self.fs.readFile(path, function(err, data) {
                if(self.shouldAbortRequest(tag)) {
                    return;
                }

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                self.pendingTags[tag].data = data;
                _read(data);
            });
            break;

        case P9_TWRITE:
            var req = marshall.Unmarshall2(["w", "d", "w"], GetByte);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = self.fids[fid].path;

            message.Debug("[twrite]: fid=" + fid + " path=" + path + " offset=" + offset + " count=" + count);

            self.fs.open(path, 'w', function(err, fd) {
                if(self.shouldAbortRequest(tag)) {
                    if(fd) self.fs.close(fd);
                    return;
                }

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                var data = new Filer.Buffer(count);
                for(var i=0; i<count; i++)
                    data[i] = GetByte();

                self.fs.write(fd, data, 0, count, offset, function(err, nbytes) {
                    if(self.shouldAbortRequest(tag)) {
                        if(fd) self.fs.close(fd);
                        return;
                    }

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }
    
                    self.fs.close(fd);

                    marshall.Marshall(["w"], [nbytes], self.replybuffer, 7);
                    self.BuildReply(id, tag, 4);
                    self.SendReply(0, index);        
                });
            });

            break;
        
        case P9_TRENAMEAT:
            var req = marshall.Unmarshall2(["w", "s", "w", "s"], GetByte);
            var olddirfid = req[0];
            var oldname = req[1];
            var oldPath = Filer.Path.join(self.fids[olddirfid].path, oldname);
            var newdirfid = req[2];
            var newname = req[3];
            var newPath = Filer.Path.join(self.fids[newdirfid].path, newname);
            message.Debug("[renameat]: oldPath=" + oldPath + " newPath=" + newPath);

            self.fs.rename(oldPath, newPath, function(err) {
                if(self.shouldAbortRequest(tag)) {
                    return;
                }

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                self.BuildReply(id, tag, 0);
                self.SendReply(0, index);    
            });

            break;

        case P9_TUNLINKAT:
            var req = marshall.Unmarshall2(["w", "s", "w"], GetByte);
            var dirfd = req[0];
            var name = req[1];
            var flags = req[2];
            var path = Filer.Path.join(self.fids[dirfd].path, name);

            message.Debug("[tunlinkat]: path=" + path);

            self.fs.stat(path, function(err, stats) {
                if(self.shouldAbortRequest(tag)) {
                    return;
                }

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }
          
                var op = stats.type === 'DIRECTORY' ? 'rmdir' : 'unlink';
                self.fs[op](path, function(err) {
                    if(self.shouldAbortRequest(tag)) {
                        return;
                    }

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }

                    self.BuildReply(id, tag, 0);
                    self.SendReply(0, index);        
                });
            });

            break;

        case P9_TVERSION:
            var version = marshall.Unmarshall2(["w", "s"], GetByte);
            message.Debug("[version]: msize=" + version[0] + " version=" + version[1]);
            this.msize = version[0];
            size = marshall.Marshall(["w", "s"], [this.msize, this.VERSION], this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(0, index);
            break;

        case P9_TATTACH: // attach - size[4] Tattach tag[2] fid[4] afid[4] uname[s] aname[s]
            /**
             * Return the root directory's QID
             * https://web.archive.org/web/20170601070930/http://plan9.bell-labs.com/magic/man2html/5/attach
             * 
             * "The fid supplied in an attach message will be taken by the server to refer to the root
             * of the served file tree. The attach identifies the user to the server and may specify a
             * particular file tree served by the server (for those that supply more than one).
             * Permission to attach to the service is proven by providing a special fid, called afid,
             * in the attach message. This afid is established by exchanging auth messages and
             * subsequently manipulated using read and write messages to exchange authentication
             * information not defined explicitly by 9P. Once the authentication protocol is complete,
             * the afid is presented in the attach to permit the user to access the service."
             * http://plan9.bell-labs.com/magic/man2html/5/0intro
             */
            var req = marshall.Unmarshall2(["w", "w", "s", "s", "w"], GetByte);
            var fid = req[0];
            var uid = req[4];
            message.Debug("[attach]: fid=" + fid + " afid=" + hex8(req[1]) + " uname=" + req[2] + " aname=" + req[3]);
            this.fids[fid] = this.Createfid('/', FID_INODE, uid);
            
            self.fs.stat('/', function (err, stats) {
                if(self.shouldAbortRequest(tag)) {
                    return;
                }

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                var qid = formatQid('/', stats);

                marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                self.BuildReply(id, tag, 13);
                self.SendReply(0, index);    
            });

            break;

        case P9_TFLUSH:
            /**
             * "A client can send multiple T–messages without waiting for the corresponding R–messages,
             * but all outstanding T–messages must specify different tags. The server may delay the
             * response to a request and respond to later ones; this is sometimes necessary, for example
             * when the client reads from a file that the server synthesizes from external events such as
             * keyboard characters."
             */
            var req = marshall.Unmarshall2(["h"], GetByte);
            var oldtag = req[0];
            this.flushTag(oldtag);
            message.Debug("[flush] " + tag);
            //marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            break;

        case P9_TWALK:
            /**
             * "A walk message causes the server to change the current file associated with a fid
             * to be a file in the directory that is the old current file, or one of its subdirectories.
             * Walk returns a new fid that refers to the resulting file. Usually, a client maintains a 
             * fid for the root, and navigates by walks from the root fid."
             */
            var req = marshall.Unmarshall2(["w", "w", "h"], GetByte);
            var fid = req[0];
            var nwfid = req[1];
            var nwname = req[2];
            message.Debug("[walk]: fid=" + req[0] + " nwfid=" + req[1] + " nwname=" + nwname);
            if (nwname == 0) {
                self.fids[nwfid] = self.Createfid(self.fids[fid].path, FID_INODE, self.fids[fid].uid);
                //this.fids[nwfid].inodeid = this.fids[fid].inodeid;
                marshall.Marshall(["h"], [0], self.replybuffer, 7);
                self.BuildReply(id, tag, 2);
                self.SendReply(0, index);
                break;
            }
            var wnames = [];
            for(var i=0; i<nwname; i++) {
                wnames.push("s");
            }
            var walk = marshall.Unmarshall2(wnames, GetByte);
            path = this.fids[fid].path;

            var offset = 7+2;
            var nwidx = 0;
            message.Debug("walk in dir " + path  + " to: " + walk.toString());

            // Given a path, and list of successive dir entries, walk from one to the
            // next, advanced nwfid, and collect qid info for each part.
            function _walk(path, pathParts) {
                var part = pathParts.shift();

                if(!part) {
                    marshall.Marshall(["h"], [nwidx], self.replybuffer, 7);
                    self.BuildReply(id, tag, offset-7);
                    self.SendReply(0, index);
                    return;
                }

                path = Filer.Path.join(path, part);
                self.fs.stat(path, function (err, stats) {
                    if(self.shouldAbortRequest(tag)) {
                        return;
                    }

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }
    
                    var qid = formatQid(path, stats);

                    self.fids[nwfid] = self.Createfid(path, FID_INODE, stats.uid);
                    offset += marshall.Marshall(["Q"], [qid], self.replybuffer, offset);
                    nwidx++;
                    _walk(path, pathParts);
                });
            }

            _walk(path, walk);

/**
 *  I think I can just join all the path parts in nwname[] together to get the final path...
            for(var i=0; i<nwname; i++) {
                idx = this.fs.Search(idx, walk[i]);

                if (idx == -1) {
                   message.Debug("Could not find: " + walk[i]);
                   break;
                }
                offset += marshall.Marshall(["Q"], [this.fs.inodes[idx].qid], this.replybuffer, offset);
                nwidx++;
                //message.Debug(this.fids[nwfid].inodeid);
                //this.fids[nwfid].inodeid = idx;
                //this.fids[nwfid].type = FID_INODE;
                this.fids[nwfid] = this.Createfid(idx, FID_INODE, this.fids[fid].uid);
            }
            marshall.Marshall(["h"], [nwidx], this.replybuffer, 7);
            this.BuildReply(id, tag, offset-7);
            this.SendReply(0, index);
*/

            break;

        case P9_TCLUNK:
            var req = marshall.Unmarshall2(["w"], GetByte);
            var fid = req[0];
            var path = self.fids[fid].path

            message.Debug("[clunk]: fid=" + fid + " path=" + path);
            delete self.fids[fid];

            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            
            break;

        // TODO: need to figure this out for Filer.  Don't have a way to test
        // in the Linux VM yet.  See http://man7.org/linux/man-pages/man2/setxattr.2.html
        case P9_TXATTRCREATE:
            var req = marshall.Unmarshall2(["w", "s", "d", "w"], GetByte);
            var fid = req[0];
            var name = req[1];
            var attr_size = req[2];
            var flags = req[3];
            message.Debug("[txattrcreate]: fid=" + fid + " name=" + name + " attr_size=" + attr_size + " flags=" + flags);
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            //this.SendError(tag, "Operation i not supported",  EINVAL);
            //this.SendReply(0, index);
            break;

        // TODO: need to figure this out for Filer.
        case P9_TXATTRWALK:
            var req = marshall.Unmarshall2(["w", "w", "s"], GetByte);
            var fid = req[0];
            var newfid = req[1];
            var name = req[2];
            message.Debug("[xattrwalk]: fid=" + req[0] + " newfid=" + req[1] + " name=" + req[2]);
            this.fids[newfid] = this.Createfid(this.fids[fid].inodeid, FID_NONE, this.fids[fid].uid);
            //this.fids[newfid].inodeid = this.fids[fid].inodeid;
            //this.fids[newfid].type = FID_NONE;
            var length = 0;
            if (name == "security.capability") {
                length = this.fs.PrepareCAPs(this.fids[fid].inodeid);
                this.fids[newfid].type = FID_XATTR;
            }
            marshall.Marshall(["d"], [length], this.replybuffer, 7);
            this.BuildReply(id, tag, 8);
            this.SendReply(0, index);
            break;

        default:
            message.Debug("Error in Virtio9p: Unknown id " + id + " received");
            message.Abort();
            //this.SendError(tag, "Operation i not supported",  ENOTSUPP);
            //this.SendReply(0, index);
            break;
    }

    //consistency checks if there are problems with the filesystem
    //this.fs.Check();
}
