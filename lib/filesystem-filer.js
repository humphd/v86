// XXX: hack to allow easy loading of FS from browser/starter.js

// -------------------------------------------------
// ----------------- FILESYSTEM---------------------
// -------------------------------------------------
// Implementation of a unix filesystem in memory.

"use strict";

/** @constructor */
function FS() {
    this.fs = new window.Filer.FileSystem();
}
