module.exports = {
    entry: "./bin/main.js",
    target: "node",
    mode: "production",
    output: {
        path: __dirname,
        filename: 'index.js'
    }
}
