const express = require('express')
const { createBundleRenderer } = require('vue-server-renderer')
const fs = require('fs')
const favicon = require('serve-favicon')
const LRU = require('lru-cache')
const compression = require('compression')

const config = require('./config')

module.exports = app => {
  const isProd = process.env.NODE_ENV === 'production'
  const templatePath = config.templatePath

  try {
    // Vue bundle renderer
    let renderer
    // In development: wait for webpack compilation
    // when receiving a SSR request
    let readyPromise

    const defaultRendererOptions = {
      cache: LRU({
        max: 1000,
        maxAge: 1000 * 60 * 15,
      }),
      runInNewContext: false,
      inject: false,
    }

    if (isProd) {
      // In production: create server renderer using template and built server bundle.
      // The server bundle is generated by vue-ssr-webpack-plugin.
      const template = fs.readFileSync(templatePath, 'utf-8')
      const serverBundle = require('../dist/vue-ssr-server-bundle.json')
      // The client manifests are optional, but it allows the renderer
      // to automatically infer preload/prefetch links and directly add <script>
      // tags for any async chunks used during render, avoiding waterfall requests.
      const clientManifest = require('../dist/vue-ssr-client-manifest.json')
      renderer = createBundleRenderer(serverBundle, {
        ...defaultRendererOptions,
        template,
        clientManifest,
      })
    } else {
      // In development: setup the dev server with watch and hot-reload,
      // and create a new renderer on bundle / index template update.
      const { setupDevServer } = require('./dev-server')
      readyPromise = setupDevServer({
        server: app,
        templatePath,
        onUpdate: ({ serverBundle }, options) => {
          // Re-create the bundle renderer
          renderer = createBundleRenderer(serverBundle, {
            ...defaultRendererOptions,
            ...options,
          })
        },
      })
    }

    // Serve static files
    const serve = (filePath, cache) => express.static(filePath, {
      maxAge: cache && isProd ? 1000 * 60 * 60 * 24 * 30 : 0,
    })

    // Serve static files
    app.use(compression({ threshold: 0 }))
    app.use(favicon(config.favicon))
    if (config.api.hasPlugin('pwa')) {
      app.get('/service-worker.js', serve(config.serviceWorkerPath))
    }
    app.use(serve(config.distPath, true))

    // Render the Vue app using the bundle renderer
    const renderApp = (req, res) => {
      res.setHeader('Content-Type', 'text/html')

      const context = {
        req,
        url: req.url,
        title: config.defaultTitle,
      }
      renderer.renderToString(context, (err, html) => {
        if (err) {
          const code = 500
          console.error(`error during render : ${req.url}`)
          console.error(err)

          // Render Error Page
          res.status(code)
          res.send('500 | Internal Server Error')
        } else {
          res.status(context.httpCode || 200).send(html)
        }
      })
    }

    // Process SSR requests
    let ssr
    if (isProd) {
      ssr = renderApp
    } else {
      // In development: wait for webpack compilation
      // when receiving a SSR request
      ssr = (req, res) => {
        readyPromise.then(() => renderApp(req, res)).catch(console.error)
      }
    }
    app.get('*', (req, res, next) => {
      if (config.skipRequests(req)) {
        return next()
      }
      ssr(req, res)
    })
  } catch (e) {
    console.error(e)
  }
}