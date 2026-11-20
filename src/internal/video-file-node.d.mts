/** Internal Node implementation including test hooks. */
import type {DestinationAttemptBinding,DestinationRecoveryService,DestinationScope,DestinationRequest,DestinationSupport} from './video-destination-contract.js';
import type {ExternalVideoDestination,ExternalVideoIfExists} from './video-external-types.js';
export interface NodeVideoReceipt {
    readonly attemptId:string;
    readonly size:number;
    readonly path:string;
    read():Promise<Uint8Array<ArrayBuffer>>;
}
export interface NodeVideoDestination {
    readonly scope:DestinationScope;
    bind(name:string):Omit<DestinationAttemptBinding<NodeVideoReceipt>,'destination'> & {
        readonly destination:Omit<ExternalVideoDestination<NodeVideoReceipt>,'checkSupport'> & {
            checkSupport<P extends ExternalVideoIfExists>(request:DestinationRequest<P>):Promise<DestinationSupport<P>>;
        };
    };
    readonly recovery:DestinationRecoveryService<NodeVideoReceipt>;
    readonly stats:Readonly<{liveHandles:number;physical:number;peakPhysical:number;borrowedBytes:number;peakBorrowedBytes:number;publications:number;journalWrites:number;cleanupFailures:number}>;
    invalidate():void;
}
export interface NodeDestinationOptions {
    readonly trust:'controlled-local-directory';
    readonly maxWriteBytes?:number;
    readonly maxAttempts?:number;
    /** Private fault injection, never enabled by default. */
    readonly fault?:(point:string,context:Readonly<{key:DestinationAttemptBinding<NodeVideoReceipt>['key'];target:string;journalPath:string;stagePath:string;receiptPath:string}>)=>Promise<void>|void;
    readonly shortWrite?:number;
    readonly publish?:(operation:()=>Promise<void>,context:Readonly<{key:DestinationAttemptBinding<NodeVideoReceipt>['key'];policy:'error'|'replace'}>)=>Promise<void>;
}
export declare function provisionNodeVideoDestination(directory:string,options:NodeDestinationOptions):Promise<NodeVideoDestination>;
