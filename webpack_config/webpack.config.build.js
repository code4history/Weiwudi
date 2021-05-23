const webpack = require('webpack');

module.exports = {
    mode: 'production',
    devtool: 'source-map',
    entry: {
        'weiwudi_sw': './src/weiwudi_sw.js'
    },
    output: {
        path: `${__dirname}/../lib`,
        filename: '[name].js'
    },
    resolve: {
        fallback: {
            path: false
        }
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