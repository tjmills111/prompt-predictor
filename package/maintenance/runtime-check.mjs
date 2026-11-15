// File-based smoke check avoids Windows PowerShell 5.1 stripping quotes from node -e.
import {DatabaseSync} from 'node:sqlite';
import {zstdDecompressSync} from 'node:zlib';
if(typeof WebSocket!=='function'||typeof zstdDecompressSync!=='function')throw Error('Unsupported Node runtime');
const database=new DatabaseSync(':memory:');database.close();
console.log(JSON.stringify({node:process.version,sqlite:true,zstandard:true,websocket:true}));
