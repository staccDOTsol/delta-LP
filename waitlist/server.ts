import { resolve } from 'node:path';
import express from 'express';
import { configuredApp } from './app.ts';

const app = configuredApp();
const production = process.argv.includes('--production');
const vite = production ? null : await (await import('vite')).createServer({ server:{middlewareMode:true,hmr:false},appType:'spa' });
if (vite) app.use(vite.middlewares);
else { app.use(express.static(resolve('dist')));app.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/index.html'))); }
const server=app.listen(Number(process.env.PORT ?? 4317),'127.0.0.1',()=>console.log('deltaLP waitlist → http://127.0.0.1:4317'));
let closing=false;
function stop(){if(closing)return;closing=true;server.close(async()=>{await vite?.close();process.exit(0);});}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
