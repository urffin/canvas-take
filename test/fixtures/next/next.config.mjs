export default {
    trailingSlash: true,
    async headers() {
        return [{ source: '/:path*', headers: [
            { key: 'Content-Security-Policy', value: "worker-src 'self'" }
        ] }];
    }
};
