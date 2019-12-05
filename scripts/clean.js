const { unlink } = require("fs").promises;
const { join } = require("path");

const files = ["index.js"];
files.map(file => join(process.cwd(), file)).forEach(async path => await unlink(path));
