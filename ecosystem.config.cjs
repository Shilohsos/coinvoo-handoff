// ecosystem.config.cjs — committed for reference (docs/07-ops-deploy.md §3)
module.exports = {
  apps: [{
    name: 'coinvoo',
    script: 'src/server.js',
    cwd: '/srv/coinvoo',
    interpreter: 'node',
    max_memory_restart: '300M',
    autorestart: true,
    watch: false,
    env: { NODE_ENV: 'production' }
  }]
};
