/// <reference path="..\compiler\commandLineParser.ts" />
/// <reference path="..\services\services.ts" />
/// <reference path="protocol.d.ts" />
/// <reference path="session.ts" />
/// <reference path="node.d.ts" />

namespace ts.server {

    const path: typeof NodeJS.path = require("path");
    const crypto: any = require("crypto");
    const fs: any = require("fs");


    /* tslint:disable */
    function createMap<T>(): Map<T> {
        return Object.create(null);
    }
    /* tslint:enable */

    export interface BuilderHost {
        logError(err: Error, cmd: string): void;
        event(info: any, eventName: string): void;
        useCaseSensitiveFileNames(): boolean;
    }

    export interface Builder {
        fileCreated(file: string): void;
        fileOpened(file: string): void;
        fileChanged(file: string): void;
        fileClosed(file: string): void;
        fileDeleted(file: string): void;
    }

    class NullBuilder implements Builder  {
        constructor(private project: Project, host: BuilderHost) {
        }
        public fileCreated(file: string): void {
        }
        public fileOpened(file: string): void {
        }
        public fileChanged(file: string): void {
        }
        public fileClosed(file: string): void {
        }
        public fileDeleted(file: string): void {
        }
    }

    interface Item<T> {
        previous: Item<T>;
        next: Item<T>;
        key: string;
        value: T;
    }

    class CompileQueue<T> {

        private map: Map<Item<T>>;
        private head: Item<T>;
        private tail: Item<T>;
        private _length: number;

        constructor() {
            this.map = createMap<Item<T>>();
            this.head = undefined;
            this.tail = undefined;
            this._length = 0;
        }

        public isEmpty(): boolean {
            return !this.head && !this.tail;
        }

        public length(): number {
            return this._length;
        }

        public get(key: string): T {
            const item = this.map[key];
            if (!item) {
                return undefined;
            }
            return item.value;
        }

        public add(key: string, value: T, touch = false): void {
            let item = this.map[key];
            if (item) {
                item.value = value;
                if (touch) {
                    this.touch(item);
                }
            }
            else {
                item = { key, value, next: undefined, previous: undefined };
                if (touch) {
                    this.addItemFirst(item);
                }
                else {
                    this.addItemLast(item);
                }
                this.map[key] = item;
                this._length++;
            }
        }

        public remove(key: string): T {
            const item = this.map[key];
            if (!item) {
                return undefined;
            }
            delete this.map[key];
            this.removeItem(item);
            this._length--;
            return item.value;
        }

        public shift(): T {
            if (!this.head && !this.tail) {
                return undefined;
            }
            const item = this.head;
            delete this.map[item.key];
            this.removeItem(item);
            this._length--;
            return item.value;
        }

        private addItemFirst(item: Item<T>): void {
            // First time Insert
            if (!this.head && !this.tail) {
                this.tail = item;
            }
            else {
                item.next = this.head;
                this.head.previous = item;
            }
            this.head = item;
        }

        private addItemLast(item: Item<T>): void {
            // First time Insert
            if (!this.head && !this.tail) {
                this.head = item;
            }
            else {
                item.previous = this.tail;
                this.tail.next = item;
            }
            this.tail = item;
        }

        private removeItem(item: Item<T>): void {
            if (item === this.head && item === this.tail) {
                this.head = undefined;
                this.tail = undefined;
            }
            else if (item === this.head) {
                this.head = item.next;
            }
            else if (item === this.tail) {
                this.tail = item.previous;
            }
            else {
                const next = item.next;
                const previous = item.previous;
                next.previous = previous;
                previous.next = next;
            }
        }

        private touch(item: Item<T>): void {
            if (item === this.head)
                return;

            const next = item.next;
            const previous = item.previous;

            // Unlink the item
            if (item === this.tail) {
                this.tail = previous;
            }
            else {
                // Both next and previous are not null since item was neither head nor tail.
                next.previous = previous;
                previous.next = next;
            }

            // Insert the node at head
            item.previous = undefined;
            item.next = this.head;
            this.head.previous = item;
            this.head = item;
        }
    }

    interface BuilderAccessor<T extends FileInfo> {
        getProject(): Project;
        getFileInfo(fileName: string): T;
        queueFileInfo(fileInfo: T, touch?: boolean): void;
    }

    interface FileInfo {
        fileName(): string;
        needsCheck(builder: BuilderAccessor<FileInfo>): boolean;
        syntacticCheck(builder: BuilderAccessor<FileInfo>): Diagnostic[];
        semanticCheck(builder: BuilderAccessor<FileInfo>): Diagnostic[];
        update(builder: BuilderAccessor<FileInfo>): boolean;
    }

    abstract class AbstractFileInfo {

        protected _shapeSignature: string;

        protected _hasSyntacticProblems: boolean;
        protected _hasSemanticProblems: boolean;

        constructor(protected _fileName: string) {
            this._shapeSignature = undefined;
        }

        public fileName(): string {
            return this._fileName;
        }

        public shapeSignature(): string {
            return this._shapeSignature;
        }

        protected computeHash(text: string): string {
            return crypto.createHash("md5")
                .update(text)
                .digest("base64");
        }

        public syntacticCheck(builder: BuilderAccessor<FileInfo>): Diagnostic[] {
            this._hasSyntacticProblems = undefined;
            this._hasSemanticProblems = undefined;
            const diagnostics = builder.getProject().compilerService.languageService.getSyntacticDiagnostics(this._fileName);
            this._hasSyntacticProblems = diagnostics && diagnostics.length > 0;
            return diagnostics;
        }

        public semanticCheck(builder: BuilderAccessor<FileInfo>): Diagnostic[] {
            this._hasSemanticProblems = undefined;
            const diagnostics = builder.getProject().compilerService.languageService.getSemanticDiagnostics(this._fileName);
            this._hasSemanticProblems = diagnostics && diagnostics.length > 0;
            return diagnostics;
        }

        protected getSourceFile(builder: BuilderAccessor<FileInfo>): SourceFile {
            return builder.getProject().compilerService.languageService.getProgram().getSourceFile(this._fileName);
        }

        protected updateShapeSignature(builder: BuilderAccessor<FileInfo>, sourceFile: SourceFile, contentSignature?: string): boolean {
            const lastSignature: string = this._shapeSignature;
            this._shapeSignature = undefined;
            if (sourceFile.isDeclarationFile) {
                this._shapeSignature =  contentSignature ? contentSignature : this.computeHash(sourceFile.text);
            }
            else {
                // ToDo@dirkb for now we can only get the declaration file if we emit all files.
                // We need to get better here since we can't emit JS files on type. Or ???
                const emitOutput = builder.getProject().compilerService.languageService.getEmitOutput(this._fileName);
                let dtsFound = false;
                for (const file of emitOutput.outputFiles) {
                    if (/\.d\.ts$/.test(file.name)) {
                        this._shapeSignature = this.computeHash(file.text);
                        dtsFound = true;
                    }
                }
                if (!dtsFound && contentSignature) {
                    this._shapeSignature = contentSignature;
                }
            }
            return !this._shapeSignature || lastSignature !== this._shapeSignature;
        }
    }

    abstract class AbstractBuilder<T extends FileInfo> implements BuilderAccessor<T> {

        private immediateId: any;
        private _compileQueue: CompileQueue<T>;

        constructor(protected project: Project, protected host: BuilderHost, private delay: number) {
            this._compileQueue = new CompileQueue<T>();
        }

        public getProject(): Project {
            return this.project;
        }

        public abstract getFileInfo(key: string): T;

        public queueFileInfo(fileInfo: T, touch?: boolean): void {
            if (!fileInfo.needsCheck(this)) {
                return;
            }
            this._compileQueue.add(fileInfo.fileName(), fileInfo, touch);
        }

        protected unqueueFileInfo(fileName: string) {
            this._compileQueue.remove(fileName);
        }

        public getCanonicalFileName(file: string) {
            const name = this.host.useCaseSensitiveFileNames() ? file : file.toLowerCase();
            return ts.normalizePath(name);
        }

        public fileCreated(file: string): void {
        }

        public fileOpened(file: string): void {
        }

        public fileChanged(file: string): void {
        }

        public fileClosed(file: string): void {
        }

        public fileDeleted(file: string): void {
        }

        private formatDiagnostics(file: string, diagnostic: ts.Diagnostic): protocol.Diagnostic {
            const host = this.getProject().compilerService.host;
            return {
                start: host.positionToLineOffset(file, diagnostic.start),
                end: host.positionToLineOffset(file, diagnostic.start + diagnostic.length),
                text: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
            };
        }

        private sendSyntaticDiagnostics(fileName: string, diagnostics: Diagnostic[]): void {
            if (diagnostics) {
                this.host.event({
                    file: fileName,
                    diagnostics: diagnostics.map(diagnostic => this.formatDiagnostics(fileName, diagnostic))
                }, "syntaxDiag");
            }
        }

        private sendSemanticDiagnostic(fileName: string, diagnostics: Diagnostic[], queueLength?: number): void {
            if (diagnostics) {
                this.host.event({
                    file: fileName,
                    diagnostics: diagnostics.map(diagnostic => this.formatDiagnostics(fileName, diagnostic)),
                    queueLength: queueLength
                }, "semanticDiag");
            }
        }

        protected processCompileQueue() {
            if (this.immediateId) {
                return;
            }
            if (this._compileQueue.isEmpty()) {
                this.compileQueueIsEmpty();
                return;
            }
            this.immediateId = setImmediate(() => {
                this.immediateId = undefined;
                const fileInfo = this._compileQueue.shift();
                if (!fileInfo) {
                    this.compileQueueIsEmpty();
                    return;
                }
                const fileName = fileInfo.fileName();
                try {
                    this.sendSyntaticDiagnostics(fileName, fileInfo.syntacticCheck(this));
                }
                catch (err) {
                    this.host.logError(err, "syntactic check");
                }
                this.immediateId = setImmediate(() => {
                    this.immediateId = undefined;
                    let diagnostics: Diagnostic[];
                    try {
                        diagnostics = fileInfo.semanticCheck(this);
                    }
                    catch (err) {
                        this.host.logError(err, "semantic check");
                    }
                    try {
                        this.updateCompileQueue(fileInfo);
                        this.sendSemanticDiagnostic(fileName, diagnostics, this._compileQueue.length());
                    } finally {
                        this.processCompileQueue();
                    }
                });
            });
        }

        protected abstract updateCompileQueue(fileInfo: T): void;

        protected abstract compileQueueIsEmpty(): void;
    }

    class SimpleFileInfo extends AbstractFileInfo implements FileInfo {

        constructor(fileName: string) {
            super(fileName);
        }

        public needsCheck(): boolean {
            return true;
        }

        public update(builder: BuilderAccessor<FileInfo>): boolean {
            const sourceFile = builder.getProject().compilerService.languageService.getProgram().getSourceFile(this.fileName());
            return this.updateShapeSignature(builder, sourceFile);
        }
    }

    class SingleRunFileInfo implements FileInfo {

        constructor(private info: FileInfo) {
        }

        public fileName(): string {
            return this.info.fileName();
        }

        public needsCheck(builder: BuilderAccessor<FileInfo>): boolean {
            return this.info.needsCheck(builder);
        }

        public syntacticCheck(builder: BuilderAccessor<FileInfo>): Diagnostic[] {
            return this.info.syntacticCheck(builder);
        }

        public semanticCheck(builder: BuilderAccessor<FileInfo>): Diagnostic[] {
            return this.info.semanticCheck(builder);
        }

        public update(builder: BuilderAccessor<FileInfo>): boolean {
            return false;
        }
    }

    class OpenFilesBuilder extends AbstractBuilder<FileInfo> implements Builder, BuilderAccessor<FileInfo> {

        private openFiles: Map<SimpleFileInfo>;

        constructor(project: Project, channel: BuilderHost, delay = -1, private limit = -1) {
            super(project, channel, delay);
            this.openFiles = createMap<SimpleFileInfo>();
        }

        public getFileInfo(file: string): SimpleFileInfo {
            return this.openFiles[file];
        }

        public fileOpened(file: string): void {
            this.fileChanged(file);
        }

        public fileChanged(file: string): void {
            if (path.basename(file) === "lib.d.ts") {
                return;
            }
            let fileInfo = this.openFiles[file];
            if (!fileInfo) {
                const sourceFile = this.project.compilerService.languageService.getProgram().getSourceFile(file);
                if (sourceFile) {
                    fileInfo = new SimpleFileInfo(file);
                }
            }
            if (!fileInfo) {
                return;
            }
            this.openFiles[file] = fileInfo;
        }

        public fileClosed(file: string): void {
            delete this.openFiles[file];
            this.unqueueFileInfo(file);
        }

        protected updateCompileQueue(fileInfo: SimpleFileInfo): void {
            if (!fileInfo.update(this)) {
                return;
            }
            Object.keys(this.openFiles).forEach((key) => {
                if (key === fileInfo.fileName()) {
                    return;
                }
                this.queueFileInfo(new SingleRunFileInfo(this.openFiles[key]));
            });
        }

        protected compileQueueIsEmpty(): void {
        }
    }

    type ModuleFileInfoState = [string, string, string, boolean, boolean];

    class ModuleFileInfo extends AbstractFileInfo implements FileInfo {

        private finalized: boolean;
        private sourceFileVersion: string;
        private references: ModuleFileInfo[];
        private referencedBy: ModuleFileInfo[];

        private contentSignature: string;
        private lastCheckedFingerPrint: string;

        constructor(filename: string, content: string) {
            super(filename);
            this.finalized = false;
            this.sourceFileVersion = undefined;
            this.references = undefined;
            this.referencedBy = undefined;
            this.contentSignature = this.computeHash(content);
            this.lastCheckedFingerPrint = undefined;
        }

        private static binarySearch(array: ModuleFileInfo[], value: string): number {
            if (!array) {
                return -1;
            }
            let low = 0;
            let high = array.length - 1;

            while (low <= high) {
                const middle = ((low + high) / 2) | 0;
                const midValue = array[middle].fileName();
                if (midValue === value) {
                    return middle;
                }
                else if (midValue > value) {
                    high = middle - 1;
                }
                else {
                    low = middle + 1;
                }
            }
            return ~low;
        }

        private static compareFileInfos(lf: ModuleFileInfo, rf: ModuleFileInfo): number {
            const l = lf.fileName();
            const r = rf.fileName();
            return (l < r ? -1 : (l > r ? 1 : 0));
        };

        private static addElement(array: ModuleFileInfo[], finalized: boolean, file: ModuleFileInfo): void {
            if (finalized) {
                const insertIndex = ModuleFileInfo.binarySearch(array, file.fileName());
                if (insertIndex < 0) {
                    array.splice(~insertIndex, 0, file);
                }
            }
            else {
                array.push(file);
            }
        }

        private static removeElement(array: ModuleFileInfo[], finalized: boolean, file: ModuleFileInfo): void {
            if (!array) {
                return;
            }
            if (finalized) {
                const index = ModuleFileInfo.binarySearch(array, file.fileName());
                if (index >= 0) {
                    array.splice(index, 1);
                }
            }
            else {
                const fileName = file.fileName();
                for (let i = 0; i < array.length; i++) {
                    if (fileName === array[i].fileName()) {
                        array.splice(i, 1);
                        break;
                    }
                }
            }
        }

        public getState(): ModuleFileInfoState {
            if (this.contentSignature === undefined || this._shapeSignature === undefined || this._hasSyntacticProblems === undefined || this._hasSemanticProblems === undefined) {
                return undefined;
            }
            return [this._fileName, this.contentSignature, this._shapeSignature, this._hasSyntacticProblems, this._hasSemanticProblems];
        }

        public initializeFromState(state: ModuleFileInfoState): boolean {
            const contentSignature = state[1];
            if (contentSignature === this.contentSignature) {
                this._shapeSignature = state[2];
                this._hasSyntacticProblems = state[3];
                this._hasSemanticProblems = state[4];
                return true;
            }
            else {
                return false;
            }
        }

        public needsInitialCompile(): boolean {
            return !(this._hasSemanticProblems === false && this._hasSyntacticProblems === false);
        }

        public sameStateAs(state: ModuleFileInfoState): boolean {
            const myState = this.getState();
            if (!myState) {
                return false;
            }
            for (let i = 0 ; i < myState.length; i++) {
                if (myState[i] !== state[i]) {
                    return false;
                }
            }
            return true;
        }

        public needsCheck(builder: BuilderAccessor<ModuleFileInfo>): boolean {
            if (!this.lastCheckedFingerPrint || this.sourceFileVersion !== this.getSourceFile(builder).version) {
                return true;
            }
            return this.lastCheckedFingerPrint != this.computeCheckFingerPrint();
        }

        private computeCheckFingerPrint(): string {
            const hash = crypto.createHash("md5");
            hash.update(this.sourceFileVersion);
            if (this.references) {
                for (const reference of this.references) {
                    // If we have a shape signature prefer it over a version id
                    // since it triggers less compiles.
                    // ToDo@dirk: we need to switch between shape and version 
                    const value = reference.sourceFileVersion;
                    hash.update(value);
                }
            }
            return hash.digest("base64");
        }

        public buildDependencies(builder: BuilderAccessor<ModuleFileInfo>, program: Program): void {
            this.getReferencedFileInfos(builder, program.getSourceFile(this.fileName())).forEach((fileInfo) => {
                fileInfo.addReferencedBy(this);
                this.addReferences(fileInfo);
            });
        }

        private getReferencedFileInfos(builder: BuilderAccessor<ModuleFileInfo>, sourceFile: SourceFile): ModuleFileInfo[] {
            const modules = sourceFile.resolvedModules;
            const result: ModuleFileInfo[] = [];
            if (modules) {
                // We need to use a set here since the code can contain the same import twice,
                // but that will only be one dependency.
                const referencedModules = createMap<boolean>();
                for (const key of Object.keys(modules)) {
                    const module = modules[key];
                    // ToDo@dirkb the resolved modules contain keys with undefined values for 
                    // modules declared as declare module "fs" { .... }. Ignore for now.
                    if (!module || !module.resolvedFileName) {
                        continue;
                    }
                    referencedModules[module.resolvedFileName] = true;
                }
                for (const key of Object.keys(referencedModules)) {
                    const fileInfo = builder.getFileInfo(key);
                    if (fileInfo) {
                        result.push(fileInfo);
                    }
                }
            }
            return result;
        }

        public finalize(builder: BuilderAccessor<ModuleFileInfo>): void {
            if (this.references) {
                this.references.sort(ModuleFileInfo.compareFileInfos);
            }
            if (this.referencedBy) {
                this.referencedBy.sort(ModuleFileInfo.compareFileInfos);
            }
            this.sourceFileVersion = this.getSourceFile(builder).version;
            this.finalized = true;
        }

        public update(builder: BuilderAccessor<ModuleFileInfo>): boolean {
            const program = builder.getProject().compilerService.languageService.getProgram();
            const sourceFile = program.getSourceFile(this.fileName());

            const newVersion = sourceFile.version;
            if (this.sourceFileVersion !== newVersion) {
                const newReferences: ModuleFileInfo[] = this.getReferencedFileInfos(builder, sourceFile);
                newReferences.sort(ModuleFileInfo.compareFileInfos);

                const currentReferences = this.references || [];
                const end = Math.max(currentReferences.length, newReferences.length);
                let currentIndex = 0;
                let newIndex = 0;
                while (currentIndex < end && newIndex < end) {
                    const currentInfo = currentReferences[currentIndex];
                    const newInfo = newReferences[newIndex];
                    const compare = ModuleFileInfo.compareFileInfos(currentInfo, newInfo);
                    if (compare < 0) {
                        // New reference is greater then current reference. That means
                        // the current reference doesn't exist anymore after parsing. So delete
                        // references.
                        currentInfo.removeReferencedBy(this);
                        currentIndex++;
                    }
                    else if (compare > 0) {
                        // A new reference info. Add it.
                        newInfo.addReferencedBy(this);
                        newIndex++;
                    }
                    else {
                        // Equal. Go to next
                        currentIndex++;
                        newIndex++;
                    }
                }
                // Clean old references
                for (let i = currentIndex; i < currentReferences.length; i++) {
                    currentReferences[i].removeReferencedBy(this);
                }
                // Update new references
                for (let i = newIndex; i < newReferences.length; i++) {
                    newReferences[i].addReferencedBy(this);
                }
                this.references = newReferences.length > 0 ? newReferences : undefined;
                this.contentSignature = this.computeHash(sourceFile.text);
                this.sourceFileVersion = newVersion;
            }
            this.lastCheckedFingerPrint = this.computeCheckFingerPrint();

            return this.updateShapeSignature(builder, sourceFile, this.contentSignature);
        }

        protected addReferencedBy(file: ModuleFileInfo): void {
            if (!this.referencedBy) {
                this.referencedBy = [];
                this.referencedBy.push(file);
                return;
            }
            ModuleFileInfo.addElement(this.referencedBy, this.finalized, file);
        }

        protected removeReferencedBy(file: ModuleFileInfo): void {
            ModuleFileInfo.removeElement(this.referencedBy, this.finalized, file);
        }

        public queueReferencedBy(builder: BuilderAccessor<ModuleFileInfo>): void {
            if (this.referencedBy) {
                this.referencedBy.forEach((fileInfo) => builder.queueFileInfo(fileInfo));
            }
        }

        public hasReferences(): boolean {
            return this.references ? this.references.length > 0 : false;
        }

        protected addReferences(file: ModuleFileInfo): void {
            if (!this.references) {
                this.references = [];
                this.references.push(file);
                return;
            }
            ModuleFileInfo.addElement(this.references, this.finalized, file);
        }

        protected removeReferences(file: ModuleFileInfo): void {
            ModuleFileInfo.removeElement(this.references, this.finalized, file);
        }
    }

    class ModuleBuilder extends AbstractBuilder<ModuleFileInfo> implements Builder, BuilderAccessor<ModuleFileInfo> {

        private static MinimalDeltaPackage = 16;

        private fileInfos: Map<ModuleFileInfo>;
        private compileRuns: number;

        private stateDirectory: string;
        private deltaState: Map<ModuleFileInfoState>;
        private deltaStateFile: string;
        private updatingDeltaState: boolean;

        constructor(project: Project, host: BuilderHost) {
            super(project, host, -1);
            this.compileRuns = 0;
            this.deltaState = createMap<ModuleFileInfoState>();
        }

        public getFileInfo(file: string): ModuleFileInfo {
            if (!this.fileInfos) {
                return undefined;
            }
            return this.fileInfos[file];
        }

        public fileOpened(file: string): void {
            this.computeDiagnostics(file);
        }

        public fileChanged(file: string): void {
            this.computeDiagnostics(file);
        }

        protected updateCompileQueue(fileInfo: ModuleFileInfo): void {
            if (fileInfo.update(this)) {
                fileInfo.queueReferencedBy(this);
            }
            const state = fileInfo.getState();
            if (state) {
                this.deltaState[fileInfo.fileName()] = state;
            }
        }

        protected compileQueueIsEmpty(): void {
            this.compileRuns++;
            if (this.compileRuns === 1) {
                this.saveFullState();
            }
            else {
                this.updateDeltaState();
            }
        }

        private computeDiagnostics(changedFile: string): void {
            this.ensureDependencyGraph();
            if (changedFile) {
                const fileInfo = this.fileInfos[changedFile];
                if (fileInfo) {
                    this.queueFileInfo(fileInfo, /*touch*/ true);
                    this.processCompileQueue();
                }
            }
        }

        private ensureDependencyGraph(): void {
            if (this.fileInfos) {
                return;
            }
            this.fileInfos = createMap<ModuleFileInfo>();
            const fileNames = this.project.getFileNames();
            const program = this.project.compilerService.languageService.getProgram();
            const fileInfos = fileNames.reduce<ModuleFileInfo[]>((memo, file) => {
                const basename = path.basename(file);
                if (basename === "lib.d.ts") {
                    return memo;
                }
                const sourceFile = program.getSourceFile(file);
                if (sourceFile) {
                    const fileInfo = new ModuleFileInfo(file, sourceFile.text);
                    this.fileInfos[fileInfo.fileName()] = fileInfo;
                    memo.push(fileInfo);
                }
                return memo;
            }, []);
            const states = this.readState();
            const roots: ModuleFileInfo[] = [];
            fileInfos.forEach((fileInfo) => {
                fileInfo.buildDependencies(this, program);
                if (!fileInfo.hasReferences()) {
                    roots.push(fileInfo);
                }
            });

            if (states) {
                fileInfos.forEach((fileInfo) => {
                    const state = states[fileInfo.fileName()];
                    if (state) {
                        fileInfo.initializeFromState(state);
                    }
                    fileInfo.finalize(this);
                    if (fileInfo.needsInitialCompile()) {
                        this.queueFileInfo(fileInfo);
                    }
                });
            }
            else {
                fileInfos.forEach((fileInfo) => fileInfo.finalize(this));
                roots.forEach(fileInfo => this.queueFileInfo(fileInfo));
            }
        }

        private getStateDirectory(): string {
            const metaDataDirectory = this.project.projectService.metaDataDirectory;
            const projectFilename = this.project.projectFilename;
            if (!metaDataDirectory || !projectFilename) {
                return undefined;
            }
            if (this.stateDirectory) {
                return this.stateDirectory;
            }
            const fileNameHash = crypto.createHash("md5").update(projectFilename).digest("hex");
            this.stateDirectory = path.join(this.project.projectService.metaDataDirectory, fileNameHash);
            return this.stateDirectory;
        }

        private saveFullState(): void {
            const stateDirectory = this.getStateDirectory();
            if (!stateDirectory) {
                return;
            }

            try {
                fs.mkdirSync(stateDirectory);
            }
            catch (err) {
            }
            const stateFileName = `c-${Date.now().toString()}.state`;
            const content: string[] = [];
            Object.keys(this.fileInfos).forEach((key) => {
                const fileInfo = this.fileInfos[key];
                const state = fileInfo.getState();
                if (state) {
                    content.push(JSON.stringify(state));
                }
            });
            function write(fd: any, index: number) {
                if (index < content.length) {
                    fs.write(fd, content[index] + "\n", undefined, "utf8", (err: Error, written: any, str: any) => {
                        if (err) {
                            return;
                        }
                        write(fd, index + 1);
                    });
                }
                else {
                    fs.close(fd, (err: Error) => {
                    });
                }
            }
            if (content.length > 0) {
                fs.open(path.join(stateDirectory, stateFileName), "w", (err: Error, fd: any) => {
                    if (err) {
                        return;
                    }
                    write(fd, 0);
                });
            }
        }

        private updateDeltaState(): void {
            if (this.updatingDeltaState) {
                return;
            }
            const stateDirectory = this.getStateDirectory();
            if (!stateDirectory) {
                return;
            }
            const keys = Object.keys(this.deltaState);
            if (keys.length < ModuleBuilder.MinimalDeltaPackage) {
                return;
            }
            const states: ModuleFileInfoState[] = [];
            for (const key of keys) {
                states.push(this.deltaState[key]);
            }
            if (!this.deltaStateFile) {
                this.deltaStateFile = `d-${Date.now().toString()}.state`;
            }
            this.updatingDeltaState = true;
            fs.appendFile(path.join(stateDirectory, this.deltaStateFile), states.map(state => JSON.stringify(state)).join("\n") + "\n", (err: Error) => {
                this.updatingDeltaState = false;
                if (err) {
                    // Received an error. Don't clean written data.
                    return;
                }
                for (const state of states) {
                    const fileName = state[0];
                    const fileInfo = this.fileInfos[fileName];
                    if (fileInfo && fileInfo.sameStateAs(state)) {
                        delete this.deltaState[fileName];
                    }
                }
                // There might already be enough changes to do another save run.
                this.updateDeltaState();
            });
        }

        private readState(): Map<ModuleFileInfoState> {
            const metaDataDirectory = this.project.projectService.metaDataDirectory;
            const projectFilename = this.project.projectFilename;
            if (!metaDataDirectory || !projectFilename) {
                return undefined;
            }
            const fileNameHash = crypto.createHash("md5").update(projectFilename).digest("hex");
            const stateDirectory = path.join(this.project.projectService.metaDataDirectory, fileNameHash);
            try {
                if (!fs.existsSync(stateDirectory)) {
                    return undefined;
                }
                const files: string[] = fs.readdirSync(stateDirectory);
                const toDelete: string[] = [];
                let latestCompleteStateFile: string;
                let latestCompleteStateTime: number;
                let latestDeltaStateFile: string;
                let latestDeltaStateTime: number;
                for (const file of files) {
                    if (file === "." || file === "..") {
                        continue;
                    }
                    if (file.length > 1 && file.charAt(1) === "-") {
                        if (file.charAt(0) === "c") {
                            const stateTime = Number(file.substring(2, file.length - 6));
                            if (!latestCompleteStateFile) {
                                latestCompleteStateFile = file;
                                latestCompleteStateTime = stateTime;
                            }
                            else {
                                if (stateTime > latestCompleteStateTime) {
                                    toDelete.push(latestCompleteStateFile);
                                    latestCompleteStateFile = file;
                                    latestCompleteStateTime = stateTime;
                                }
                                else {
                                    toDelete.push(file);
                                }
                            }
                        }
                        else if (file.charAt(0) === "d") {
                            const stateTime = Number(path.basename(file.substring(2, file.length - 6)));
                            if (!latestDeltaStateFile) {
                                latestDeltaStateFile = file;
                                latestDeltaStateTime = stateTime;
                            }
                            else {
                                if (stateTime > latestDeltaStateTime) {
                                    toDelete.push(latestDeltaStateFile);
                                    latestDeltaStateFile = file;
                                    latestDeltaStateTime = stateTime;
                                }
                                else {
                                    toDelete.push(file);
                                }
                            }
                        }
                    }
                }
                // A delta file must always be never as the complete file we parse.
                if (latestCompleteStateFile && latestDeltaStateFile && latestCompleteStateTime > latestDeltaStateTime) {
                    toDelete.push(latestDeltaStateFile);
                    latestDeltaStateFile = undefined;
                    latestDeltaStateTime = undefined;
                }
                if (!latestCompleteStateFile) {
                    return undefined;
                }
                let result: Map<ModuleFileInfoState> = createMap<ModuleFileInfoState>();
                const parseContent = (content: string, stateFileTime: number) => {
                    let start = 0;
                    for (let index = 0; index < content.length; index++) {
                        if (content.charAt(index) === "\n") {
                            try {
                                const state: ModuleFileInfoState = JSON.parse(content.substring(start, index));
                                start = index + 1;
                                const fileName = state[0];
                                try {
                                    const stat  = fs.statSync(fileName);
                                    if (stat.mtime > stateFileTime) {
                                        delete result[fileName];
                                    }
                                    else {
                                        result[fileName] = state;
                                    }
                                }
                                catch (err) {
                                    delete result[fileName];
                                }
                            }
                            catch (err) {
                                // The file seems to be corrupted. Stop processing and return.
                                result = undefined;
                                return;
                            }
                        }
                    }
                };
                if (latestCompleteStateFile) {
                    parseContent(fs.readFileSync(path.join(stateDirectory, latestCompleteStateFile), { encoding: "utf8" }), latestCompleteStateTime);
                }
                if (result && latestDeltaStateFile) {
                    parseContent(fs.readFileSync(path.join(stateDirectory, latestDeltaStateFile), { encoding: "utf8" }), latestDeltaStateTime);
                }

                // Cleanup unneeded state files files.
                toDelete.forEach(file => {
                    // Can be done async. If an unlink fails we clean it up the next round.
                    fs.unlink(path.join(stateDirectory, file), (err: Error) => {});
                });
                return result;
            }
            catch (err) {
                // We couldn't read the state directory. Start with a fresh state.
                return undefined;
            }
        }
    }

    export function createBuilder(project: Project, builderHost: BuilderHost): Builder {
        if (!project.projectService.autoBuild) {
            return new NullBuilder(project, builderHost);
        }
        if (!project.isConfiguredProject()) {
            return new OpenFilesBuilder(project, builderHost);
        }
        const options = project.projectOptions;
        if (!options || !options.autoBuild) {
            return new OpenFilesBuilder(project, builderHost);
        }

        if (options.compilerOptions && options.compilerOptions.module) {
            const moduleKind = options.compilerOptions.module;
            switch (moduleKind) {
                case ModuleKind.AMD:
                case ModuleKind.CommonJS:
                case ModuleKind.UMD:
                case ModuleKind.System:
                    return new ModuleBuilder(project, builderHost);
                default:
                    return new OpenFilesBuilder(project, builderHost);
            }
        }
        else {
            // What is the default module system in TS?
        }
    }
}