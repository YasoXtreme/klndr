// klndr's scene files are browser scripts that also export through
// module.exports, so they are required rather than imported - and TypeScript
// has to be told that `require` exists in the bundle.
declare const require: (path: string) => any;
