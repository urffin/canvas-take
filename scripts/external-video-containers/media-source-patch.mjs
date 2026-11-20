/** Make encoded-source close work observable and awaitable for external output. */
export function patchExternalMediaSource(source){
 const once=(from,to)=>{if(source.split(from).length!==2)throw Error('Pinned external media-source anchor changed: '+from);source=source.replace(from,to);};
 once('if (this._closingPromise) {\n            return;\n        }','if (this._closingPromise) {\n            return this._closingPromise;\n        }');
 once('            connectedTrack.output._muxer.onTrackClose(connectedTrack);\n        })();','            await connectedTrack.output._muxer.onTrackClose(connectedTrack);\n        })();\n        return this._closingPromise;');
 return source;
}
