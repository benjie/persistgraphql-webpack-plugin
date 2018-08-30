module.exports = function() {
  this.cacheable();
  this.callback(null, 'module.exports = {};');
};
