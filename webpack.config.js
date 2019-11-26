const { BannerPlugin } = require("webpack");

module.exports = {
    entry: "./bin/main.js",
    target: "node",
    mode: "production",
    output: {
        path: __dirname,
        filename: 'index.js'
    },
    plugins: [
        new BannerPlugin({ banner: "#!/usr/bin/env node", raw: true }),
    ]
}
