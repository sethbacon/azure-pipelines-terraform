const path = require('path');
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = {
    mode: 'production',
    entry: {
        'tab/tabContent': './src/tab/tabContent.tsx'
    },
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'build')
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js'],
        alias: {
            'azure-devops-extension-sdk': path.resolve('node_modules/azure-devops-extension-sdk')
        }
    },
    optimization: {
        minimize: false
    },
    performance: {
        hints: false
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                loader: 'ts-loader',
                options: {
                    configFile: path.resolve(__dirname, 'src/tab/tsconfig.json')
                },
                exclude: /node_modules/
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader']
            }
        ]
    },
    plugins: [
        new CopyWebpackPlugin({
            patterns: [
                { from: "./images", to: "images", context: "." },
                { from: "./overview.md", to: "overview.md" },
                { from: "./LICENSE", to: "./" },
                { from: "./THIRD_PARTY_NOTICES.md", to: "./" },
                { from: "./azure-devops-extension.json", to: "azure-devops-extension.json" },
                { from: "./src/tab/index.html", to: "tab/index.html" },
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
