import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {abcDir} from './abc-collect.mjs';

/** Read-only open for screening-report — no mkdir/schema/migrate/init. */
export function openAbcReadonly(home) {
  const dir=abcDir(home);
  const path=resolve(dir,'abc.sqlite');
  if(!existsSync(path)) {
    return {dir,db:null,missing:true,readOnly:true,
      bump(){throw new Error('ABC_READONLY');},
      stat(){return 0;},
      close(){},
    };
  }
  const db=new DatabaseSync(path,{readOnly:true});
  try {db.exec('PRAGMA query_only=ON');} catch {}
  return {dir,db,missing:false,readOnly:true,
    bump(){throw new Error('ABC_READONLY');},
    stat(key){const r=db.prepare('SELECT value FROM stats WHERE key=?').get(key);return r?r.value:0;},
    close(){db.close();},
  };
}
