const webpack = require('webpack');

module.exports = {
    mode: 'production',
    devtool: 'source-map',
    entry: {
        'index': './test/src/index.js'
    },
    output: {
        path: `${__dirname}/../test/dist_cdn`,
        filename: '[name].js'
    },
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