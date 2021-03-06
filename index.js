var VirtualModulesPlugin = require('webpack-virtual-modules');
var RawSource = require('webpack-sources').RawSource;
var ExtractGQL = require('@benjie/persistgraphql/lib/src/ExtractGQL').ExtractGQL;
var path = require('path');
var addTypenameTransformer = require('@benjie/persistgraphql/lib/src/queryTransformers').addTypenameTransformer;
var graphql = require('graphql');
var _ = require('lodash');
var crypto = require('crypto');

function hash(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function PersistGraphQLPlugin(options) {
  this.options = options || {};
  if (!this.options.moduleName)
    throw new Error("moduleName option is required for PersistGraphQLPlugin");
  if (this.options.provider) {
    this.options.provider._addListener(this);
  } else {
    this._listeners = [];
  }
  this.virtualModules = new VirtualModulesPlugin();
}

PersistGraphQLPlugin.prototype._addListener = function(listener) {
  this._listeners.push(listener);
};

PersistGraphQLPlugin.prototype._notify = function(queryMap) {
  var self = this;

  if (self._queryMap !== queryMap) {
    self.virtualModules.writeModule(self.options.moduleName, queryMap);
  }
  self._queryMap = queryMap;
  if (self._callback) {
    self._callback();
    delete self._callback;
  }
};

PersistGraphQLPlugin.prototype.apply = function(compiler) {
  var self = this;

  self.virtualModules.apply(compiler);
  self._compiler = compiler;

  compiler.plugin('compilation', function(compilation) {
    if (!self._queryMap && !compilation.compiler.parentCompilation) {
      self.virtualModules.writeModule(self.options.moduleName, '{}');
    }
  });

  compiler.plugin('normal-module-factory', function(nmf) {
    nmf.plugin('after-resolve', function(result, callback) {
      if (!result) {
        return callback();
      }
      if (self.options.provider &&
          result.request.indexOf(self.options.moduleName) >= 0 &&
          !self._queryMap) {
        self._callback = function() {
          return callback(null, result);
        }
      } else {
        return callback(null, result);
      }
    });
  });

  if (!self.options.provider) {
    compiler.plugin('compilation', function(compilation) {
      if (!compilation.compiler.parentCompilation) {
        compilation.plugin('seal', function() {
          var graphQLString = '';
          var allQueries = [];
          function processGraphQLString(stringToProcess) {
            var extractor = new ExtractGQL({inputFilePath: '',
              queryTransformers: self.options.addTypename ? [function(doc) {
              return addTypenameTransformer(JSON.parse(JSON.stringify(doc)));
            }] : undefined});

            var doc = graphql.parse(stringToProcess);
            var docMap = graphql.separateOperations(doc);
            var queries = {};
            Object.keys(docMap).forEach(function (operationName) {
              var document = docMap[operationName];
              var fragmentMap = {};
              for (var i = document.definitions.length - 1; i >= 0; i--) {
                var def = document.definitions[i];
                if (def.kind === 'FragmentDefinition') {
                  if (!fragmentMap[def.name.value]) {
                    fragmentMap[def.name.value] = true;
                  } else {
                    document.definitions.splice(i, 1);
                  }
                }
              }
              queries = _.merge(queries, extractor.createMapFromDocument(document));
            });

            Object.keys(queries).forEach(function(query) {
              allQueries.push(query);
            });
          }
          compilation.modules.forEach(function(module) {
            var queries = module._graphQLQueries;
            if (queries) {
              Object.keys(queries).forEach(function(query){
                graphQLString += query;
              })
            } else if (module._graphQLString) {
              graphQLString += module._graphQLString;
            }
          });

          if (graphQLString) {
            processGraphQLString(graphQLString);
          }

          var mapObj = {};

          allQueries.sort().forEach(function(query) {
            mapObj[query] = hash(query);
          });

          var newQueryMap = JSON.stringify(mapObj);
          if (newQueryMap !== self._queryMap) {
            self._queryMap = newQueryMap;
            self.virtualModules.writeModule(self.options.moduleName, self._queryMap);
            compilation.modules.forEach(function(module) {
              if (module.resource === self.options.moduleName ||
                module.resource === path.resolve(path.join(compiler.context, self.options.moduleName))) {
                module._source._value = "module.exports = " + self._queryMap + ";";
              }
            });
          }
          self._listeners.forEach(function(listener) { listener._notify(self._queryMap); });
        });
      }
    });
  }
  if (self.options.filename) {
    compiler.plugin('after-compile', function(compilation, callback) {
      if (!compilation.compiler.parentCompilation) {
        compilation.assets[self.options.filename] = new RawSource(self._queryMap);
      }
      callback();
    });
  }
};

module.exports = PersistGraphQLPlugin;
