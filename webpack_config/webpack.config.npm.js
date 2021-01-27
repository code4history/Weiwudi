const webpack = require('webpack');
const {InjectManifest} = require('workbox-webpack-plugin');

module.exports = {
    mode: 'production',
    devtool: 'source-map',
    entry: {
        'index': './test/src/index.js'
    },
    output: {
        path: `${__dirname}/../test/dist_npm`,
        filename: '[name].js'
    },
    plugins: [
        new InjectManifest({
            swDest: "./sw.js",
            swSrc: './test/src/sw_npm.js'
        })
    ],
    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        "presets": [
                            [
                                "@babel/preset-env",
                                {
                                    "useBuiltIns": "usage",
                                    "corejs": 3
                                }
                            ]
                        ]
                    }
                }
            }
        ]
    }
};