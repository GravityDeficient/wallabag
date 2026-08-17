const path = require('path');
const webpack = require('webpack');
const StyleLintPlugin = require('stylelint-webpack-plugin');

const projectDir = path.resolve(__dirname, '../../../');

module.exports = {
  entry: {
    material: path.join(projectDir, './app/Resources/static/themes/material/index.js'),
    public: path.join(projectDir, './app/Resources/static/themes/_global/share.js'),
    // Separate bundle rather than an import into material/index.js. The built
    // assets in web/wallassets/ are committed, so folding this in would produce
    // a minified-bundle conflict on every upstream release; as its own entry it
    // emits new files and leaves material.js byte-identical to upstream.
    tts: path.join(projectDir, './app/Resources/static/themes/material/tts/index.js'),
  },
  output: {
    filename: '[name].js',
    path: path.resolve(projectDir, 'web/wallassets'),
    publicPath: '',
  },
  plugins: [
    new webpack.ProvidePlugin({
      $: 'jquery',
      jQuery: 'jquery',
      'window.$': 'jquery',
      'window.jQuery': 'jquery',
    }),
    new StyleLintPlugin({
      configFile: 'stylelint.config.js',
      failOnError: false,
      quiet: false,
      context: 'app/Resources/static/themes',
      files: '**/*.scss',
    }),
  ],
  resolve: {
    alias: {
      jquery: path.join(projectDir, 'node_modules/jquery/dist/jquery.js'),
    },
  },
};
