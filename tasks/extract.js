var path = require('path');
var fs = require('fs');

var acorn = require('acorn');
var acornWalk = require('../node_modules/acorn/dist/walk');
var moment = require('moment');
var nunjucksParser = require('nunjucks').parser;
var nunjucksNodes = require('../node_modules/nunjucks/src/nodes');

var PO_HEADER = [
  'msgid ""',
  'msgstr ""',
  '"Project-Id-Version: PACKAGE VERSION\\n"',
  '"Report-Msgid-Bugs-To: \\n"',
  '"POT-Creation-Date: ' + moment().format('YYYY-MM-DD HH:MMZZ') + '\\n"',
  '"PO-Revision-Date: YEAR-MO-DA HO:MI+ZONE\\n"',
  '"Last-Translator: Automatically generated\\n"',
  '"Language-Team: none\\n"',
  '"Language: \\n"',
  '"MIME-Version: 1.0\\n"',
  '"Content-Type: text/plain; charset=UTF-8\\n"',
  '"Content-Transfer-Encoding: 8bit\\n"',
  '"X-Generator: Translate Toolkit 1.6.0\\n"',
  '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
].join('\n') + '\n\n';


module.exports = function(grunt) {
  var extensionToExtractors = {
    '.html': extractNunjucks,
    '.js': extractJavasript,
  };

  grunt.registerMultiTask('extract', 'Extract strings for l10n', function() {
    this.files.map(function(file) {
      var stringSets = file.src.map(function(filepath) {
        var extension = path.extname(filepath);
        var extractor = extensionToExtractors[extension];

        if (extractor === undefined) {
          grunt.fail.fatal('No extraction method defined for extension ' + extension + ' (' + filepath + ')');
          return [];
        }

        return extractor(filepath);
      });

      // flatten stringSets
      var extractedStrings = Array.prototype.concat.apply([], stringSets);
      extractedStrings = dedupeStrings(extractedStrings);
      writePotFile(extractedStrings, file.dest);
    });
  });

  function extractNunjucks(filepath) {
    var contents = grunt.file.read(filepath);

    var parseTree;
    try {
      parseTree = nunjucksParser.parse(contents);
    } catch (err) {
      console.log(JSON.stringify(err));
      grunt.fail.warn('Error while parsing ' +
                      filepath + ':' + err.lineno + ':' + err.colno +
                      '\n' + err.toString());
      return;
    }

    return parseTree.findAll(nunjucksNodes.FunCall)
    .filter(function(node) {
      // Exclude functions calls that aren't to gettext.
      return (
        node.name &&
        node.name instanceof nunjucksNodes.Symbol &&
        ['_', '_plural'].indexOf(node.name.value) !== -1
      );
    })
    .map(function(node) {
      var errorLocation = filepath + ':' + node.lineno;

      switch (node.name.value) {
        case '_':
          if (node.args.children.length < 1) {
            grunt.fail.warn('Empty gettext call at ' + errorLocation);
            return null;
          }

          var stringNode = node.args.children[0];
          if (!(stringNode instanceof nunjucksNodes.Literal)) {
            grunt.fail.warn('Cannot localize non-literal at ' + errorLocation);
            return null;
          }

          return {
            locations: [{filepath: filepath, lineno: node.lineno}],
            msgid: stringNode.value,
          };

        case '_plural':
          if (node.args.children.length < 3) {
            grunt.fail.warn('Incomplete plural gettext call at ' + errorLocation);
            return null;
          }
          var singularNode = node.args.children[0];
          var pluralNode = node.args.children[1];

          if (!(singularNode instanceof nunjucksNodes.Literal) ||
              !(pluralNode instanceof nunjucksNodes.Literal)) {
            grunt.fail.warn('Cannot localize non-literal at ' + errorLocation);
            return null;
          }

          return {
            locations: [{filepath: filepath, lineno: node.lineno}],
            msgid: singularNode.value,
            msgid_plural: pluralNode.value,
          };

        default:
          grunt.fail.warn('Unknown type of localization at ' + errorLocation);
          return null;
      }
    })
    .filter(function(string) {
      return string !== null;
    });
  }

  function extractJavasript(filepath) {
    return walk(parse(filepath))
    .filter(filterCalls)
    .map(makeString);

    function parse(filepath) {
      var contents = grunt.file.read(filepath);
      var ast;
      try {
        ast = acorn.parse(contents, {
          locations: true,
          ecmaVersion: 6,
        });
      } catch (err) {
        grunt.fail.warn('Error while parsing ' + filepath + '\n' + err.toString());
      }
      return ast;
    }

    function walk(ast) {
      var nodes = [];
      acornWalk.simple(ast, {
        CallExpression: function(node) {
          nodes.push(node);
        },
      });
      return nodes;
    }

    function filterCalls(callExpr) {
      return (
        callExpr.callee.type === 'Identifier' &&
        ['gettext', 'ngettext'].indexOf(callExpr.callee.name) != -1
      );
    }

    function makeString(callExpr) {
      var errorLocation = filepath + ':' + callExpr.loc.start.line;

      switch (callExpr.callee.name) {
        case 'gettext':
          if (callExpr.arguments.length < 1) {
            grunt.fail.warn('Empty gettext call at ' + errorLocation);
            return null;
          }

          if (callExpr.arguments[0].type !== 'Literal') {
            grunt.fail.warn('Cannot localize non-literal at ' + errorLocation);
            return null;
          }

          return {
            locations: [{filepath: filepath, lineno: callExpr.loc.start.line}],
            msgid: callExpr.arguments[0].value,
          };

        case 'ngettext':
          if (callExpr.arguments.length < 2) {
            grunt.fail.warn('Incomplete ngettext call at ' + errorLocation);
            return null;
          }

          if (callExpr.arguments[0].type !== 'Literal' ||
              callExpr.arguments[1].type !== 'Literal') {
            grunt.fail.warn('Cannot localize non-literal at ' + errorLocation);
            return null;
          }

          return {
            locations: [{filepath: filepath, lineno: callExpr.loc.start.line}],
            msgid: callExpr.arguments[0].value,
            msgid_plural: callExpr.arguments[1].value,
          };

        default:
          grunt.fail.warn('Unknown type of localization at ' + errorLocation);
          return null;
      }
    }
  }

  function dedupeStrings(strings) {
    // Object<msgid, string>
    var seen = {};
    strings.forEach(function(str) {
      if (str.msgid in seen) {
        seen[str.msgid].locations = seen[str.msgid].locations.concat(str.locations);
      } else {
        seen[str.msgid] = str;
      }
    });
    var acc = [];
    for (var key in seen) {
      acc.push(seen[key]);
    }
    return acc;
  }

  function wrapInQuotes(str) {
    return '"' + str.replace(/"/g, '\\"') + '"';
  }

  function writePotFile(strings, destpath) {
    var poFragments = strings.map(function(string) {
      var parts = string.locations.map(function(loc) {
        return '#: ' + loc.filepath + ':' + loc.lineno;
      });
      parts.push('msgid ' + wrapInQuotes(string.msgid));

      if (string.msgid_plural) {
        parts = parts.concat([
          'msgid_plural ' + wrapInQuotes(string.msgid_plural),
          'msgstr[0] ""',
          'msgstr[1] ""',
        ]);
      } else {
        parts.push('msgstr ""');
      }

      return parts.join('\n');
    });

    grunt.file.write(destpath, PO_HEADER + poFragments.join('\n\n'));
  }
};
