const path = require('path');
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = {
    mode: 'production',
    entry: {},
    output: {
        path: path.resolve(__dirname, 'build')
    },
    optimization: {
        minimize: false
    },
    performance: {
        hints: false
    },
    plugins: [
        new CopyWebpackPlugin({
            patterns: [
                { from: "./images", to: "images", context: "." },
                { from: "./overview.md", to: "overview.md" },
                { from: "./LICENSE", to: "./" },
                { from: "./azure-devops-extension.json", to: "azure-devops-extension.json" },
                {
                    from: "./Tasks",
                    globOptions: {
                        dot: true,
                        gitignore: false,
                        ignore: ["**/Tests/**", "**/*.ts", "**/tsconfig*.json", "**/.eslintrc.json"],
                    },
                    to: "Tasks"
                },
            ]
        })
    ]
};
