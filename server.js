#!/usr/bin/env node
var ChangesStream = require('changes-stream')
var Follower = require('./')
var ecb = require('ecb')
var fs = require('fs')
var http = require('http')
var https = require('https')
var parse = require('json-parse-errback')
var path = require('path')
var pino = require('pino')
var pump = require('pump')
var through = require('through2')
var url = require('url')

var REPLICATE_API = 'replicate.npmjs.com'

var DIRECTORY = process.env.DIRECTORY || 'follower'

var from = null
try {
  var read = fs.readFileSync(path.join(DIRECTORY, 'sequence'))
  from = parseInt(read.toString())
} catch (error) {
  from = 0
}

var follower = new Follower(DIRECTORY)
var log = pino({
  level: 'info' || process.env.LOG_LEVEL.toLowerCase()
})

log.info({from: from}, 'starting')

var PACKAGE_PATH = new RegExp(
  '^' +
  '/packages' +
  '/([^/]+)' + // package name
  '(/([^/]+))?' + // optional package version
  '(/([1-9][0-9]+))?' + // optional sequence
  '$'
)

var server = http.createServer(function (request, response) {
  if (request.method !== 'GET') {
    response.statusCode = 405
    response.end()
    return
  }

  var pathname = url.parse(request.url).pathname
  if (pathname === '/sequence') {
    response.end(JSON.stringify(follower.sequence()))
  } else if (pathname === '/behind') {
    https.get('https://' + REPLICATE_API, function (response) {
      var buffer = []
      response
      .once('error', internalError)
      .on('data', function (chunk) {
        buffer.push(chunk)
      })
      .once('end', function () {
        var body = Buffer.concat(buffer)
        parse(body, ecb(internalError, function (body) {
          sendJSON(body.update_seq - follower.sequence())
        }))
      })
    })
  } else if (pathname === '/packages') {
    pump(
      follower.packages(),
      through.obj(function (name, _, done) {
        done(null, name + '\n')
      }),
      response
    )
  } else if (pathname.indexOf('/packages/') === 0) {
    var match = PACKAGE_PATH.exec(pathname)
    if (match) {
      var name = decodeURIComponent(match[1])
      if (match[3]) {
        var version = decodeURIComponent(match[3])
        var sequence = (
          Math.floor(Number(match[5])) ||
          follower.sequence()
        )
        follower.query(name, version, sequence, function (error, tree) {
          if (error) {
            internalError()
          } else {
            if (!tree) {
              notFound()
            } else {
              sendJSON({
                package: name,
                version: version,
                sequence: sequence,
                tree: tree
              })
            }
          }
        })
      } else {
        follower.versions(name, function (error, versions) {
          if (error) {
            internalError()
          } else {
            if (versions === null) {
              notFound()
            } else {
              sendJSON(versions)
            }
          }
        })
      }
    } else {
      notFound()
    }
  } else if (pathname === '/memory') {
    sendJSON(process.memoryUsage())
  } else {
    notFound()
  }

  function sendJSON (object) {
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(object))
  }

  function internalError () {
    response.statusCode = 500
    response.end()
  }

  function notFound () {
    response.statusCode = 404
    response.end()
  }
})

server.listen(process.env.PORT || 8080, function () {
  log.info({event: 'listening', port: this.address().port})
})

pump(
  new ChangesStream({
    db: 'https://' + REPLICATE_API,
    feed: 'continuous',
    include_docs: 'true',
    heartbeat: 'true',
    since: String(from),
    style: 'all_docs',
    highWaterMark: 2
  }),
  follower
)
  .on('error', logError)
  .on('missing', function (info) {
    log.warn(info, 'missing')
  })
  .on('updating', function (name) {
    log.info({name: name}, 'updating')
  })
  .on('versions', function (versions) {
    log.debug({versions: versions})
  })
  .on('updated', function (update) {
    log.debug({
      dependent: update.dependent,
      dependency: update.dependency
    }, 'updated')
  })
  .on('sequence', function (sequence) {
    log.info({sequence: sequence})
    fs.writeFile(SEQUENCE, String(sequence))
  })
  .on('finish', function () {
    log.info('finish')
    exit()
  })

function logError (error) {
  log.error(error)
  exit()
}

function exit () {
  server.close(function () {
    log.info('closed server')
    process.exit(1)
  })
}