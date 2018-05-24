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

// TODO
// flush
// lock?
// correct hard links

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

var FID_NONE = -1;
var FID_INODE = 1;
var FID_XATTR = 2;

function setupFS(fs) {
    var projectRoot = "/";

    var index = "<html>\n"                                  +
                "  <head>\n"                                +
                "    <title>Bramble</title>\n"              +
                "  </head>\n"                               +
                "  <body>\n"                                +
                "    <p>This is the main page.</p>\n"       +
                "  </body>\n"                               +
                "</html>";

    var css = "p {\n"                                       +
              "  color: purple;\n"                          +
              "}";

    var script = "function add(a, b) {\n"                   +
                 "  return a|0 + b|0;\n"                    +
                 "}";

    var Path = Filer.Path;
 
    // Stick things in the project root
    function writeProjectFile(path, data, callback) {
        path = Path.join(projectRoot, path);

        fs.writeFile(path, data, function(err) {
            if(err) {
                throw err;
            }
            callback();
        });
    }

    writeProjectFile("script.js", script, function() {
        writeProjectFile("style.css", css, function() {
            writeProjectFile("index.html", index, function() {
            });
        });
    });

    // Expose Filer and fs on Window for debugging
    window.fs = fs;
    window.Filer = Filer;
}

/** 
 * @constructor 
 *
 * @param {FS} filesystem
 */
function Virtio9p(filesystem, bus) {
    /** @const @type {FS} */
    this.fs = new Filer.FileSystem();
    this.sh = new this.fs.Shell();
    setupFS(this.fs);

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
}

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
    //console.trace('Createfid', arguments);
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
    //message.Debug("size:" + size + " id:" + id + " tag:" + tag);

    switch(id) {
        case P9_TSTATFS:
            // TODOhumphd: I'm not sure if I need/want to do accurate sizing info from indexeddb
            // See https://github.com/jonnysmith1981/getIndexedDbSize/blob/master/getIndexedDbSize.js
            size = 50 * 1024; // this.fs.GetTotalSize(); // size used by all files
            var space = 256 * 1024 * 1024 * 1024; //this.fs.GetSpace();
            var req = [];
            req[0] = 0x01021997;
            req[1] = this.BLOCKSIZE; // optimal transfer block size
            req[2] = Math.floor(space/req[1]); // free blocks
            req[3] = req[2] - Math.floor(size/req[1]); // free blocks in fs
            req[4] = req[2] - Math.floor(size/req[1]); // free blocks avail to non-superuser
            req[5] = this.fs.inodes.length; // total number of inodes
            req[6] = 1024*1024;
            req[7] = 0; // file system id?
            req[8] = 256; // maximum length of filenames

            size = marshall.Marshall(["w", "w", "d", "d", "d", "d", "d", "d", "w"], req, this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(0, index);
            break;

        case P9_TOPEN:
            // fall through
        case P9_TLOPEN:
            var req = marshall.Unmarshall2(["w", "w"], GetByte);
            var fid = req[0];
            var path = this.fids[fid].path;
            var mode = req[1];

            self.fs.stat(path, function (err, stat) {
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                message.Debug("[open] fid=" + fid, " path=" + path, " mode=" + mode);
                message.Debug("file opened " + stat.p9.name + " tag:"+tag);
                req[0] = stat.p9.qid;
                req[1] = self.msize - 24;
                marshall.Marshall(["Q", "w"], req, self.replybuffer, 7);
                self.BuildReply(id, tag, 13+4);
                self.SendReply(0, index);
            });

            break;

        case P9_TLINK: // just copying
            var req = marshall.Unmarshall2(["w", "w", "s"], GetByte);
            var dfid = req[0];
            var fid = req[1];
            var name = req[2];
            message.Debug("[link] dfid=" + dfid + ", name=" + name);
            var inode = this.fs.CreateInode();
            var inodetarget = this.fs.GetInode(this.fids[fid].inodeid);
            var targetdata = this.fs.inodedata[this.fids[fid].inodeid];
            //inode = inodetarget;
            inode.mode = inodetarget.mode;
            inode.size = inodetarget.size;
            inode.symlink = inodetarget.symlink;
            var data = this.fs.inodedata[this.fs.inodes.length] = new Uint8Array(inode.size);
            for(var i=0; i<inode.size; i++) {
                data[i] = targetdata[i];
            }
            inode.name = name;
            inode.parentid = this.fids[dfid].inodeid;
            this.fs.PushInode(inode);
            
            //inode.uid = inodetarget.uid;
            //inode.gid = inodetarget.gid;
            //inode.mode = inodetarget.mode | S_IFLNK;
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);       
            break;

        case P9_TSYMLINK:
            var req = marshall.Unmarshall2(["w", "s", "s", "w"], GetByte);
            var fid = req[0];
            var name = req[1];
            var symgt = req[2];
            var gid = req[3];
            message.Debug("[symlink] fid=" + fid + ", name=" + name + ", symgt=" + symgt + ", gid=" + gid); 
            var idx = this.fs.CreateSymlink(name, this.fids[fid].inodeid, symgt);
            var inode = this.fs.GetInode(idx);
            inode.uid = this.fids[fid].uid;
            inode.gid = gid;
            marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 13);
            this.SendReply(0, index);
            break;

        case P9_TMKNOD:
            var req = marshall.Unmarshall2(["w", "s", "w", "w", "w", "w"], GetByte);
            var fid = req[0];
            var name = req[1];
            var mode = req[2];
            var major = req[3];
            var minor = req[4];
            var gid = req[5];
            message.Debug("[mknod] fid=" + fid + ", name=" + name + ", major=" + major + ", minor=" + minor+ "");
            var idx = this.fs.CreateNode(name, this.fids[fid].inodeid, major, minor);
            var inode = this.fs.GetInode(idx);
            inode.mode = mode;
            inode.uid = this.fids[fid].uid;
            inode.gid = gid;
            marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 13);
            this.SendReply(0, index);
            break;

        case P9_TREADLINK:
            var req = marshall.Unmarshall2(["w"], GetByte);
            var fid = req[0];
            message.Debug("[readlink] fid=" + fid);
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            size = marshall.Marshall(["s"], [inode.symlink], this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(0, index);
            break;

        case P9_TMKDIR:
            var req = marshall.Unmarshall2(["w", "s", "w", "w"], GetByte);
            var dfid = req[0];
            var name = req[1];
            var mode = req[2];
            var gid = req[3];
            var parentPath = self.fids[dfid].path;
            var newDir = Filer.Path.join(parentPath, name);
            message.Debug("[mkdir] fid.path=" + path + ", name=" + name + ", mode=" + mode + ", gid=" + gid); 

            self.fs.mkdir(newDir, function(err) {
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                self.fs.stat(newDir, function(err, stats) {
                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }
    // XXX: we don't seem to have an fid for this new dir, so don't guess.
    //                self.fids[fid] = self.Createfid(newDir, FID_INODE, uid);
                    marshall.Marshall(["Q"], [stats.p9.qid], self.replybuffer, 7);
                    self.BuildReply(id, tag, 13);
                    self.SendReply(0, index);
                });
            });

            break;

        /**
         * TODOhumphd: seems like I should also do P9_TCREATE here, need to confirm
         */
//        case P9_TCREATE:
//            // falls through
        case P9_TLCREATE:
            // P9_TLCREATE tag 1 fid 2 name 'foo' flags 0x8241 mode 0100644 gid 500
            // P9_RLCREATE tag 1 qid (00000000002c1bd1 0 '') iounit 4096

            var req = marshall.Unmarshall2(["w", "s", "w", "w", "w"], GetByte);
            var fid = req[0];
            var name = req[1];
            var flags = req[2]; // TODO: I'm ignorning these right now.
            var mode = req[3];
            var gid = req[4];
            message.Debug("[tlcreate] fid=" + fid + ", name=" + name + ", mode=" + mode + ", gid=" + gid);

            var newFilePath = Filer.Path.join(self.fids[fid].path, name);

            // TODO: I should really be passing in this info, ignoring for now...
//            var options = {
//                p9: {
//                    mode: mode,
//                    gid: gid
//                }
//            };
            self.fs.open(newFilePath, 'w', function(err, fd) {
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }
                
                self.fs.fstat(fd, function(err, stats) {
                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }

                    self.fids[fid] = self.Createfid(newFilePath, FID_INODE, uid);
                    self.fs.close(fd);
  
                    marshall.Marshall(["Q", "w"], [stats.p9.qid, stats.msize - 24], self.replybuffer, 7);
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

        /*
        case P9_TGETLOCK:
            break;        
        */

        case P9_TGETATTR:
            var req = marshall.Unmarshall2(["w", "d"], GetByte);
            var fid = req[0];
            var path = this.fids[fid].path;
            self.fs.stat(path, function (err, stat) {
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                message.Debug("[getattr]: fid=" + fid + " name=" + stat.p9.name + " request mask=" + req[1]);

                req[0] |= 0x1000; // P9_STATS_GEN
    
                req[0] = req[1]; // request mask
                req[1] = stat.p9.qid;
    
                req[2] = stat.p9.mode; 
                req[3] = stat.p9.uid; // user id
                req[4] = stat.p9.gid; // group id
                
                req[5] = stat.nlinks; // number of hard links

                // TODOhumphd: not sure about these...
                req[6] = (0x0<<8) | (0x0); // rdev, device id low
                req[7] = stat.size; // size, low
                req[8] = self.BLOCKSIZE; // blocksize
                req[9] = Math.floor(stat.size/512+1);; // blocks, low
                req[10] = stat.atime / 1000; // atime (sec)
                req[11] = stat.atime * 1000000; //0x0; // atime_nsec
                req[12] = stat.mtime / 1000; // mtime (sec)
                req[13] = stat.mtime * 1000000; // 0x0; mtime_nsec
                req[14] = stat.ctime / 1000; // ctime (sec)
                req[15] = stat.ctime * 1000000; // 0x0; // ctime (nsec)
                req[16] = 0x0; // btime sec
                req[17] = 0x0; // btime nsec
                req[18] = 0x0; // st_gen
                req[19] = 0x0; // data_version

                marshall.Marshall([
                    "d", "Q", 
                    "w",  
                    "w", "w", 
                    "d", "d", 
                    "d", "d", "d",
                    "d", "d", // atime
                    "d", "d", // mtime
                    "d", "d", // ctime
                    "d", "d", // btime
                    "d", "d",
                ], req, self.replybuffer, 7);
                self.BuildReply(id, tag, 8 + 13 + 4 + 4+ 4 + 8*15);
                self.SendReply(0, index);
            });

            break;

        case P9_TSETATTR:
            var req = marshall.Unmarshall2(["w", "w", 
                "w", // mode 
                "w", "w", // uid, gid
                "d", // size
                "d", "d", // atime
                "d", "d"] // mtime
            , GetByte);
            var fid = req[0];
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            message.Debug("[setattr]: fid=" + fid + " request mask=" + req[1] + " name=" +inode.name);
            if (req[1] & P9_SETATTR_MODE) {
                inode.mode = req[2];
            }
            if (req[1] & P9_SETATTR_UID) {
                inode.uid = req[3];
            }
            if (req[1] & P9_SETATTR_GID) {
                inode.gid = req[4];
            }
            if (req[1] & P9_SETATTR_ATIME) {
                inode.atime = Math.floor((new Date()).getTime()/1000);
            }
            if (req[1] & P9_SETATTR_MTIME) {
                inode.mtime = Math.floor((new Date()).getTime()/1000);
            }
            if (req[1] & P9_SETATTR_CTIME) {
                inode.ctime = Math.floor((new Date()).getTime()/1000);
            }
            if (req[1] & P9_SETATTR_ATIME_SET) {
                inode.atime = req[6];
            }
            if (req[1] & P9_SETATTR_MTIME_SET) {
                inode.mtime = req[8];
            }
            if (req[1] & P9_SETATTR_SIZE) {
                this.fs.ChangeSize(this.fids[fid].inodeid, req[5]);
            }
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
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
            message.Debug("[treaddir]: fid=" + fid + " offset=" + offset + " count=" + count);

            // Directory entries are represented as variable-length records:
            // qid[13] offset[8] type[1] name[s]
            self.sh.ls(path, {recursive: false} , function(err, entries) {
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                // first get size
                var size = entries.reduce(function(currentValue, entry) {
                    return currentValue + 13 + 8 + 1 + 2 + UTF8.UTF8Length(entry.p9.name);
                }, 0);

                // Deal with . and ..
                size += 13 + 8 + 1 + 2 + 1; // "." entry
                size += 13 + 8 + 1 + 2 + 2; // ".." entry
                var data = new Uint8Array(size);

                // Get info for '.'
                self.fs.stat(path, function(err, stat) {
                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }
                            
                    var dataOffset = 0x0;

                    dataOffset += marshall.Marshall(
                        ["Q", "d", "b", "s"],
                        [stat.p9.qid, 
                        dataOffset+13+8+1+2+1, 
                        stat.p9.mode >> 12, 
                        "."],
                        data, dataOffset);
    
                    // Get info for '..'
                    var parentDirPath = Filer.Path.resolve("..", path);
                    self.fs.stat(parentDirPath, function(err, stat) {
                        if(err) {
                            self.SendError(tag, err);
                            self.SendReply(0, index);
                            return;
                        }
        
                        dataOffset += marshall.Marshall(
                            ["Q", "d", "b", "s"],
                            [stat.p9.qid,
                            dataOffset+13+8+1+2+2, 
                            stat.p9.mode >> 12, 
                            ".."],
                            data, dataOffset);
    
                        entries.forEach(function(entry) {
                            dataOffset += marshall.Marshall(
                                ["Q", "d", "b", "s"],
                                [
                                    entry.p9.qid,
                                    dataOffset+13+8+1+2+UTF8.UTF8Length(entry.p9.name),
                                    entry.p9.mode >> 12,
                                    entry.p9.name
                                ],
                                data, dataOffset);
                        });

                        // TODO: not sure about this check...
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
            message.Debug("[tread]: fid=" + fid + " offset=" + offset + " count=" + count);

            // TODO: optimize this for single db read and cache contents temporarily

            // TODO: does OPEN mean I can hold an fd for this file?
            self.fs.open(path, 'r', function(err, fd) {
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                // Create a buffer large enough to hold the file's contents
                var data = new Filer.Buffer(count);
              
                self.fs.read(fd, data, 0, count, offset, function(err, nbytes) {
                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }
               
                    self.fs.close(fd);

                    // TODO: not 100% sure about this, it seems to read past the
                    // end of the file 3 times before giving up.
//                    if (nbytes < offset+count) count = nbytes - offset;
                    // "In any event the number of bytes read is returned. A return value of 0 is conventionally interpreted as end of file."
                    if (nbytes <= 0)
                        count = 0;
                    else
                        count = nbytes;

                    for(var i=0; i<count; i++)
                        self.replybuffer[7+4+i] = data[offset+i];
                    marshall.Marshall(["w"], [count], self.replybuffer, 7);
                    self.BuildReply(id, tag, 4 + count);
                    self.SendReply(0, index);
                });
              
//            var inode = this.fs.GetInode(this.fids[fid].inodeid);
//            if (id == 40) message.Debug("[treaddir]: fid=" + fid + " offset=" + offset + " count=" + count);
//            if (id == 116) message.Debug("[read]: fid=" + fid + " (" + inode.name + ") offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type);


/** Not sure about these...
            if(!inode || inode.status === STATUS_UNLINKED)
            {
                message.Debug("read/treaddir: unlinked");
                this.SendError(tag, "No such file or directory", ENOENT);
                this.SendReply(0, index);
                break;
            }
            if (this.fids[fid].type == FID_XATTR) {
                if (inode.caps.length < offset+count) count = inode.caps.length - offset;
                for(var i=0; i<count; i++)
                    this.replybuffer[7+4+i] = inode.caps[offset+i];
                marshall.Marshall(["w"], [count], this.replybuffer, 7);
                this.BuildReply(id, tag, 4 + count);
                this.SendReply(0, index);
            }
 */
            
            });
            break;

        case P9_TWRITE:
            var req = marshall.Unmarshall2(["w", "d", "w"], GetByte);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = self.fids[fid].path;

            self.fs.open(path, 'w', function(err, fd) {
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                /**
                if (!data || data.length < (offset+count)) {
                    this.ChangeSize(id, Math.floor(((offset+count)*3)/2) );
                    inode.size = offset + count;
                    data = this.inodedata[id];
                } else
                if (inode.size < (offset+count)) {
                    inode.size = offset + count;
                }
                 */
                var data = new Filer.Buffer(count);
                for(var i=0; i<count; i++)
                    data[i] = GetByte();

                self.fs.write(fd, data, 0, count, offset, function(err, nbytes) {
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
        
        // TODOhumphd: what about P9_TRENAME?
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
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

// TODO: should I update my fid path info here?

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

            self.fs.stat(path, function(err, stats) {
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }
          
                var op = stats.type === 'DIRECTORY' ? 'rmdir' : 'unlink';
                self.fs[op](path, function(err) {
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
            
            self.fs.stat('/', function (err, stat) {
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(0, index);
                    return;
                }

                marshall.Marshall(["Q"], [stat.p9.qid], self.replybuffer, 7);
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
                self.fs.stat(path, function (err, stat) {
                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(0, index);
                        return;
                    }
    
                    self.fids[nwfid] = self.Createfid(path, FID_INODE, stat.p9.uid);
                    offset += marshall.Marshall(["Q"], [stat.p9.qid], self.replybuffer, offset);
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
