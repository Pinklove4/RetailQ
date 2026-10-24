import {app,pool} from './app.js';
const port=Number(process.env.PORT||4000);pool.query('SELECT 1').then(()=>app.listen(port,()=>console.log(`RetailQ API on ${port}`))).catch(e=>{console.error(e);process.exit(1)});
