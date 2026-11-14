import {readFile,access,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import ts from 'typescript';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const baseline='1859e9a83f8a3f01a94ec55331efeabcf54684b7';
const pkg=JSON.parse(await readFile('package.json','utf8')),old=JSON.parse(git('show',baseline+':package.json'));
assert.equal(pkg.version,'0.8.1');const normalized=structuredClone(pkg);delete normalized.scripts['test:video:output'];delete normalized.scripts['benchmark:video:output'];assert.deepEqual(normalized,old);
assert.equal(git('diff',baseline,'--name-only','--','src','vendor','.github','package-lock.json'),'');
let declarations=0,links=0;
for(const entry of Object.values(pkg.exports))if(entry.types){const source=entry.types.replace('./dist/','src/').replace(/\.d\.ts$/,'.ts'),expected=ts.transpileDeclaration(git('show',baseline+':'+source),{fileName:source,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,strict:true}}).outputText;assert.equal((await readFile(entry.types,'utf8')).replaceAll('\r\n','\n').trim(),expected.trim());declarations++;}
for(const path of ['docs/offline-video-api.md','docs/drafts/external-video-output.md','docs/drafts/video-output-memory-study.md'])for(const[,url]of(await readFile(path,'utf8')).matchAll(/\]\(([^)]+)\)/g)){if(/^(https?:|#)/.test(url))continue;await access(resolve(dirname(path),decodeURIComponent(url.split('#')[0])));links++;}
const all=(await readFile('benchmark-results/video-output-all-tests.log','utf8')).match(/# pass (\d+)\r?\n# fail 0/),focused=(await readFile('benchmark-results/video-output-receiver-tests.log','utf8')).match(/# pass (\d+)\r?\n# fail 0/);assert.ok(all);assert.ok(focused);assert.equal(Number(all[1]),222+Number(focused[1]));
git('diff','--check');const summary={version:pkg.version,publicDeclarations:declarations,localLinks:links,nodeTests:Number(all[1]),receiverTests:Number(focused[1]),publicApiDependenciesRuntimeSourceUnchanged:true,packageScriptsAdded:['test:video:output','benchmark:video:output']};await writeFile('benchmark-results/video-output-boundary-checks.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
