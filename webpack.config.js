const { resolve } = require("path");
const { BannerPlugin } = require("webpack");

module.exports = {
    entry: "./bin/main.js",
    target: "node",
    mode: "production",
    output: {
        path: resolve(__dirname, "..", ".."),
        filename: 'index.js'
    },
    plugins: [
        new BannerPlugin({ banner: "#!/usr/bin/env node", raw: true }),
    ]
}
