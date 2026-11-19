// DESIGN ONLY: noEmit fixture; do not execute or import as an application module.
import type {Support} from '@grundyjs/canvas-take/video';
import type {ExternalVideoDestination,ExternalVideoCloseReport} from './external-video-public-api.js';
import type {DestinationSupport,DestinationGuarantees,DestinationRecoveryKey,DestinationRecoverySnapshot,DestinationAttemptBinding,DestinationRecoveryService} from './external-video-destination-contract.js';

const scope={backendId:'test-backend',scopeId:'provisioned-root',profileRevision:'evidence-1'} as const;
const request={format:{mimeType:'video/mp4',extension:'mp4'},ifExists:'error',maxWriteBytes:4096} as const;
const guarantees:DestinationGuarantees<'error'>={scope,policy:'error',positionedWrites:'all-or-reject',staging:'isolated-unpublished',truncate:'exact-before-publication',publication:'atomic-at-target',recovery:'journal-before-publication',durability:'no-portable-crash-guarantee'};
const available:DestinationSupport<'error'>={supported:true,request,guarantees};
const pendingPermission:DestinationSupport<'error'>={supported:false,code:'permission-required',reason:'Acquire permission in application UI first'};
// Existing core Support can consume rich diagnostics without a controller or ABI change.
const core:Support=available;
const refused:Support=pendingPermission;
// @ts-expect-error supported diagnostics require scoped evidence, not just a boolean
const incomplete:DestinationSupport<'error'>={supported:true};
// @ts-expect-error policy-specific profiles cannot silently advertise another policy
const wrongPolicy:DestinationGuarantees<'error'>={...guarantees,policy:'replace'};
// @ts-expect-error append is not a publication policy
const append:DestinationSupport<'append'>={supported:false,code:'unsupported-policy',reason:'append unsupported'};
// @ts-expect-error target mutation during writing cannot be an isolated staging capability
const inPlace:DestinationGuarantees<'error'>={...guarantees,staging:'in-place'};
// @ts-expect-error existence-check-then-rename is not an atomic publication capability
const racy:DestinationGuarantees<'error'>={...guarantees,publication:'exists-then-rename'};
// @ts-expect-error a permission error is not a supported capability report
const prompt:DestinationSupport<'error'>={supported:true,code:'permission-required',reason:'prompt'};

const key:DestinationRecoveryKey={version:1,backendId:scope.backendId,scopeId:scope.scopeId,attemptId:'caller-known-before-create'};
// @ts-expect-error raw paths/tokens cannot be treated as a scoped recovery key
const pathKey:DestinationRecoveryKey='/tmp/export.partial';
// @ts-expect-error a recovery key needs an attempt identity independent of target name
const targetOnly:DestinationRecoveryKey={version:1,backendId:'b',scopeId:'s'};
declare const service:DestinationRecoveryService<FileSystemFileHandle>;
declare const binding:DestinationAttemptBinding<FileSystemFileHandle>;
const oldCore:ExternalVideoDestination<FileSystemFileHandle>=binding.destination;
service.inspect(key);
service.cleanup(key,{expectedRevision:'observed-revision'});
// @ts-expect-error destructive recovery cleanup must be fenced against a stale observation
service.cleanup(key,{});
// @ts-expect-error recovery has no blind commit retry operation
service.commit(key);
// @ts-expect-error recovery has no operation that deletes a published target
service.removeTarget(key);
// @ts-expect-error the caller owns the stable binding; recovery cannot retarget it
binding.key=key;

declare const observation:DestinationRecoverySnapshot<FileSystemFileHandle>;
// @ts-expect-error publication/receipt narrowing is required before recovering a value
observation.publication.receipt.value;
if(observation.publication.status==='committed'){
    // @ts-expect-error historical publication does not prove its original value is still readable
    observation.publication.receipt.value;
    if(observation.publication.receipt.status==='available'){
        const handle:FileSystemFileHandle=observation.publication.receipt.value;void handle;
    }
}
// @ts-expect-error a backend operation that may still publish cannot prove non-publication
const stillRunning:DestinationRecoverySnapshot<null>={key,revision:'r',currentTarget:'absent',staging:'retained',quiescent:false,publication:{status:'not-committed',reason:null}};
const validFalsyReceipt:DestinationRecoverySnapshot<undefined>={key,revision:'r',currentTarget:'this-attempt',staging:'retained',quiescent:true,publication:{status:'committed',receipt:{status:'available',value:undefined}}};
const superseded:DestinationRecoverySnapshot<FileSystemFileHandle>={key,revision:'r2',currentTarget:'other-publication',staging:'absent',quiescent:true,publication:{status:'committed',receipt:{status:'unavailable',reason:'Historical version no longer retained'}}};
// @ts-expect-error a successful historical publication is different from a current-value receipt
const missingValue:DestinationRecoverySnapshot<null>={key,revision:'r',currentTarget:'this-attempt',staging:'absent',quiescent:true,publication:{status:'committed',receipt:{status:'available'}}};

// Application-side recovery; this never resolves/replaces the exporter's earlier rejected finish.
export async function inspectAfterClosed(report:ExternalVideoCloseReport<FileSystemFileHandle>,attempt:DestinationAttemptBinding<FileSystemFileHandle>){
    if(report.publication!=='indeterminate')return;
    // Do not depend on report.recovery: commit throw/malformed return may omit that optional hint.
    const snapshot=await attempt.recovery.inspect(attempt.key);
    if(!snapshot.quiescent||snapshot.publication.status==='indeterminate')return 'keep-recovery-state';
    if(snapshot.publication.status==='committed'){
        if(snapshot.publication.receipt.status==='available')return snapshot.publication.receipt.value;
        return 'published-historically-no-readable-receipt';
    }
    // Backend revalidates the revision and ownership before removing only private remnants.
    const cleanup=await attempt.recovery.cleanup(attempt.key,{expectedRevision:snapshot.revision});
    return cleanup.status==='blocked'?'keep-recovery-state':'may-start-a-new-application-attempt';
}
void core;void refused;void incomplete;void wrongPolicy;void append;void inPlace;void racy;void prompt;
void pathKey;void targetOnly;void oldCore;void stillRunning;void validFalsyReceipt;void superseded;void missingValue;
