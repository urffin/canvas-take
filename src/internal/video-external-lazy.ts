import type {ExternalVideoContainer, ExternalVideoFormat, ExternalVideoMuxerFactory} from './video-external-types.js';

/** Keep the separately patched container implementation out of the Blob-only execution path. */
export function lazyExternalVideoMuxer<C extends ExternalVideoContainer>(format: ExternalVideoFormat<C>,
    load: () => Promise<ExternalVideoMuxerFactory<C>>): ExternalVideoMuxerFactory<C> {
    let pending: Promise<ExternalVideoMuxerFactory<C>> | undefined;
    const get = () => pending ??= load().catch(error => { pending = undefined; throw error; });
    Object.freeze(format);
    return {
        outputKind: 'external',
        format,
        async checkSupport(config) { return (await get()).checkSupport(config); },
        async create(config, context) { return (await get()).create(config, context); }
    };
}
