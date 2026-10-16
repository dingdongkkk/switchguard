import {createApp} from './app.js';
import {DetectifClient} from './detectif.js';
const port=Number(process.env.PORT??3000);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
const client=new DetectifClient(process.env.DETECTIF_API_TOKEN??process.env.DETECTIF_API_KEY);
const {server}=createApp(client);
server.listen(port,'127.0.0.1',()=>console.log(`SwitchGuard local development harness: http://127.0.0.1:${port} (credentials ${client.configured?'configured':'missing'})`));
