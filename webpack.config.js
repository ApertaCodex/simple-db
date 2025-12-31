const path = require('path');

module.exports = {
  target: 'node',
  mode: 'production',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  resolve: {
    extensions: ['.ts', '.js'],
    mainFields: ['browser', 'module', 'main']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: 'ts-loader'
      }
    ]
  },
  externals: {
    vscode: 'commonjs vscode',
    sqlite3: 'commonjs sqlite3',
    mongoose: 'commonjs mongoose'
  },
  optimization: {
    minimize: false
  },
  devtool: 'source-map'
};
