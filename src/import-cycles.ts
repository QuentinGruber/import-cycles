import fs from "fs"
import Path from "path"
import {
	ClassDeclaration,
	Declaration,
	File as ParsedFile,
	Import as ParserImport,
	SymbolSpecifier,
	TypescriptParser,
} from "typescript-parser"

type Imports = string[]

type FileImports = { filePath: string; imports: Imports }

type Cycle = string[]

type FileCycles = { filePath: string; cycle: Cycle[] }

export type FileSource = { filePath: string; source: string }

function resolvePath(path: string): string {
	if (!path.startsWith("/")) {
		path = Path.resolve(path)
	}
	path = path.replace(/\\/g, "/")
	return path
}

function getResolvedPaths(filesPaths: string[]) {
	return filesPaths.map((filePath) => resolvePath(filePath))
}

function isATsFile(filePath: string): boolean {
	return filePath.endsWith(".ts") || filePath.endsWith(".tsx")
}

function getSource(filePath: string): FileSource {
	return { filePath: filePath, source: fs.readFileSync(filePath, "utf8") }
}

const parser = new TypescriptParser()

async function getFilesImports(files: FileSource[]): Promise<FileImports[]> {
	// get a list of all imports in all files
	const filesImports: FileImports[] = []

	for (let index = 0; index < files.length; index++) {
		const file = files[index]
		const imports = await getImports(file)
		const fileImports: FileImports = { filePath: file.filePath, imports }
		filesImports.push(fileImports)
	}
	return filesImports
}


function readDependency(
	fileCycle: FileCycles,
	currentDependency:Dependency,
	currentDependencyPath:string
) {	
	if(currentDependency.cycleDetected.length){
		for (let index = 0; index < currentDependency.cycleDetected.length; index++) {
			const cycle = currentDependency.cycleDetected[index];
			fileCycle.cycle.push([...currentDependency.dependents,currentDependencyPath,cycle])
		}
		return;
	}
	currentDependency.dependencies.forEach((dependency) => {
		if(dependency){
			const dependencyMap = dependency.dependencies;
			if(dependencyMap){
				for(const [dependencyPath,dependency] of dependencyMap.entries()){
					if(dependency){
						readDependency(fileCycle,dependency,dependencyPath);
					}
				}
			}
		}
	});

}
async function getImportCycles(
	dependencyMap: DependencyMap
): Promise<FileCycles[]> {
	const filesCycles: FileCycles[] = []
	dependencyMap.forEach((dependency,currentDependencyPath) => {
		const fileCycle: FileCycles = { filePath: resolvePath(currentDependencyPath), cycle: [] }
		readDependency(fileCycle,dependency as unknown as Dependency,currentDependencyPath);
		if(fileCycle.cycle.length > 0){
			filesCycles.push(fileCycle)
		}
	});
	return filesCycles
}

export function isATypeExport(declaration: any) {
	return (
		getDeclarationType(declaration) === "TypeAliasDeclaration" ||
		getDeclarationType(declaration) === "InterfaceDeclaration"
	)
}

export function isAClassExport(declaration: any) {
	return getDeclarationType(declaration) === "ClassDeclaration"
}

function getAllExportedDeclaration(declarations: Declaration[]): Declaration[] {
	const exportedDeclarations: Declaration[] = []
	for (let index = 0; index < declarations.length; index++) {
		const declaration: any = declarations[index]
		if (declaration.isExported && !isATypeExport(declaration)) {
			exportedDeclarations.push(declaration)
		}
	}
	return exportedDeclarations
}

function isAssign(source: string, variable: any, className: string): boolean {
	if (variable.start && variable.end) {
		const varData = source.substring(variable.start, variable.end).split("=")[1]
		if (varData.includes(className)) {
			return true
		}
	}
	return false
}

function isReturned(
	returnStatement: string,
	linkedImportDeclarationName: string
): boolean {
	const returnStatementData = returnStatement.split("return")[1]
	if (returnStatementData.includes(linkedImportDeclarationName)) {
		return true
	}
	return false
}

function getReturnStatements(functionSource: string) {
	// if the function isn't a void function then we have to check if the class is returned
	// use a reguex to get all the return statements data from function source until next semi-colon or \r or \n
	return functionSource.match(/return[\s\S]*?;*?\r*?\n/g)
}

function getDeclarationType(declaration: any): string {
	return declaration.__proto__.constructor.name
}

function getResolvedPath(
	entryFileDirPath: string,
	libraryName: string
): string | null {
	let resolvedPath = resolvePath(`${entryFileDirPath}/${libraryName}`)
	if (!fs.existsSync(resolvedPath) || !isATsFile(resolvedPath)) {
		if (fs.existsSync(resolvedPath + ".ts")) {
			return `${resolvedPath}.ts`
		} else if (fs.existsSync(resolvedPath + ".tsx")) {
			return `${resolvedPath}.tsx`
		} else {
			return null // ignore this import
		}
	}
	return resolvedPath
}

function checkConstructorDeclaration(
	entryFileDec: Declaration,
	source: string,
	linkedImportDeclaration: Declaration
): boolean {
	if ((entryFileDec as any).ctor) {
		const constructorSource = removeAllCommentsFromTsFile(
			source.substring(
				(entryFileDec as any).ctor.start as number,
				(entryFileDec as any).ctor.end
			)
		)
		let usageCount = constructorSource.match(
			new RegExp(`\\b${linkedImportDeclaration.name}\\b`, "g")
		)?.length
		if (usageCount) {
			const constructorVariables = (entryFileDec as any).ctor.variables
			for (
				let constructorVarIndex = 0;
				constructorVarIndex < constructorVariables.length;
				constructorVarIndex++
			) {
				const constructorVar = constructorVariables[constructorVarIndex]
				if (constructorVar.type === linkedImportDeclaration.name) {
					usageCount--
				}
				if (constructorVar.name === linkedImportDeclaration.name) {
					usageCount--
				}
			}
			if (constructorSource.includes("this." + linkedImportDeclaration.name)) {
				usageCount--
			}
			if (usageCount) {
				return true
			}
		}
		return false
	}
	return false
}
function checkDeclaration(
	linkedImportDeclaration: Declaration,
	entryFiledeclarations: Declaration[],
	source: string
): boolean {
	// If this declaration is a class then we have to check how it's been used
	if (isAClassExport(linkedImportDeclaration)) {
		// check all declarated vars and all declarated vars inside functions
		for (
			let entryFileDecIndex = 0;
			entryFileDecIndex < entryFiledeclarations.length;
			entryFileDecIndex++
		) {
			const entryFileDec = entryFiledeclarations[entryFileDecIndex]
			if (getDeclarationType(entryFileDec) === "ClassDeclaration") {
				const classSource = source.substring(
					entryFileDec.start as number,
					entryFileDec.end
				)
				// check if the class is extended by the class that is being imported
				if (classSource.includes("extends")) {
					const classExtends = classSource
						.split("extends")[1]
						.split("{")[0]
						.trim()
					if (classExtends === linkedImportDeclaration.name) {
						return true
					}
				}
				const classDeclaration: any = entryFileDec as ClassDeclaration
				const classDeclarationProperties = classDeclaration.properties
				for (
					let classDecPropertyIndex = 0;
					classDecPropertyIndex < classDeclarationProperties.length;
					classDecPropertyIndex++
				) {
					const classDecProperty =
						classDeclarationProperties[classDecPropertyIndex]
					const propertySource = source.substring(
						classDecProperty.start as number,
						classDecProperty.end
					)
					if (propertySource.includes("=")) {
						const propertyAssign = propertySource
							.split("=")[1]
							.split(";")[0]
							.trim()
						if (propertyAssign.includes(linkedImportDeclaration.name)) {
							return true
						}
					}
				}
				// check if declarations/properties get assigned the linkedImportDeclaration in the constructor
				if (
					checkConstructorDeclaration(
						entryFileDec,
						source,
						linkedImportDeclaration
					)
				) {
					return true // validate the import
				}
				// check methods return statements and variable assignments
				const classDeclarationMethods = classDeclaration.methods
				for (
					let classDecMethodIndex = 0;
					classDecMethodIndex < classDeclarationMethods.length;
					classDecMethodIndex++
				) {
					const classDecMethod = classDeclarationMethods[classDecMethodIndex]
					const methodSource = source.substring(
						classDecMethod.start as number,
						classDecMethod.end
					)
					const returnStatements = getReturnStatements(methodSource)
					if (returnStatements) {
						for (
							let returnStatementIndex = 0;
							returnStatementIndex < returnStatements.length;
							returnStatementIndex++
						) {
							const returnStatement = returnStatements[returnStatementIndex]
							if (isReturned(returnStatement, linkedImportDeclaration.name)) {
								return true
							}
						}
					}
					const methodVariables = classDecMethod.variables
					for (
						let methodVarIndex = 0;
						methodVarIndex < methodVariables.length;
						methodVarIndex++
					) {
						const methodVar = methodVariables[methodVarIndex]
						if (isAssign(source, methodVar, linkedImportDeclaration.name)) {
							return true
						}
					}
				}
			} else if (getDeclarationType(entryFileDec) === "VariableDeclaration") {
				// For every variable we check if the given class is used on the right side of an assignment
				// So if the class is used statically or being instantiated
				if (isAssign(source, entryFileDec, linkedImportDeclaration.name)) {
					return true
				}
			}
			// If this is a function then we have to check for the function's variables
			// Doing like this it also ignore if a class is used as a type in function's arguments
			else if (getDeclarationType(entryFileDec) === "FunctionDeclaration") {
				for (
					let funcDecIndex = 0;
					funcDecIndex < (entryFileDec as any).variables.length;
					funcDecIndex++
				) {
					const variable = (entryFileDec as any).variables[funcDecIndex]
					if (isAssign(source, variable, linkedImportDeclaration.name)) {
						return true
					}
				}

				const functionSource = source.substring(
					entryFileDec.start as number,
					entryFileDec.end
				)
				const returnStatements = getReturnStatements(functionSource)
				if (returnStatements) {
					for (
						let returnStatementIndex = 0;
						returnStatementIndex < returnStatements.length;
						returnStatementIndex++
					) {
						const returnStatement = returnStatements[returnStatementIndex]
						if (isReturned(returnStatement, linkedImportDeclaration.name)) {
							return true
						}
					}
				}
			}
		}
		return false
	} else {
		// If this is not a class Declaration nor a typeAlias then validate the import without much checking
		return true
	}
}

function checkSpecifiers(
	specifiers: SymbolSpecifier[],
	importDeclarations: Declaration[],
	entryFiledeclarations: Declaration[],
	source: string
): boolean {
	for (let index = 0; index < specifiers.length; index++) {
		const specifier = specifiers[index]
		// for the given specifier we search for his linked declaration inside the imported module
		const linkedImportDeclaration = importDeclarations.find(
			(declaration) => declaration.name === specifier.specifier
		)
		// If none exist then we skip this import
		if (
			linkedImportDeclaration &&
			checkDeclaration(linkedImportDeclaration, entryFiledeclarations, source)
		) {
			return true
		}
	}
	return false
}

function getSpecifiers(parserImport: ParserImport): SymbolSpecifier[] {
	return (parserImport as any).specifiers as SymbolSpecifier[]
}

export async function checkIfImportExistAtRuntime(
	importFileSource: FileSource,
	parserImport: ParserImport,
	entrySource: string,
	entryFileParsed: ParsedFile
): Promise<boolean> {
	// extract data from the sources of this file
	const parsedSource = await parseSource(importFileSource.source)
	// Get all usefull declarations from the file ( ignoring TypeAliasDeclaration )
	const importDeclarations = getAllExportedDeclaration(
		parsedSource.declarations
	)

	const specifiers = getSpecifiers(parserImport)
	// for every specifier of the currently analysed import
	// We will check how there are used, example if a class is used as a type
	if (
		checkSpecifiers(
			specifiers,
			importDeclarations,
			entryFileParsed.declarations,
			entrySource
		)
	) {
		return true
	} else {
		return false
	}
}

async function validateImport(
	entryFileDirPath: string,
	entryFileParsed: ParsedFile,
	index: number,
	entrySource: string
): Promise<boolean> {
	const parserImport = entryFileParsed.imports[index]
	// check if Path point to a file format we support
	const resolvedPath = getResolvedPath(
		entryFileDirPath,
		parserImport.libraryName
	)
	if (!resolvedPath) {
		return false
	}
	const importFileSource = getSource(resolvedPath)
	if (
		await checkIfImportExistAtRuntime(
			importFileSource,
			parserImport,
			entrySource,
			entryFileParsed
		)
	) {
		return true
	}
	return false
}

async function validateImports(
	entryFileSource: FileSource,
	entryFileParsed: ParsedFile
): Promise<ParserImport[]> {
	const entryFileNormalizedPath = Path.normalize(entryFileSource.filePath)
	const entryFileDirPath = entryFileNormalizedPath.substring(
		0,
		entryFileNormalizedPath.lastIndexOf(Path.sep)
	)
	const validatedImports = []
	for (let index = 0; index < entryFileParsed.imports.length; index++) {
		if (
			await validateImport(
				entryFileDirPath,
				entryFileParsed,
				index,
				entryFileSource.source
			)
		) {
			validatedImports.push(entryFileParsed.imports[index])
		}
	}
	return validatedImports
}

function removeAllCommentsFromTsFile(source: string): string {
	let lastChar = ""
	let newSource = ""
	let stopWriting = false
	for (let index = 0; index < source.length; index++) {
		const char = source[index]
		if (char === "/" && lastChar === "/") {
			stopWriting = true
			newSource = newSource.substring(0, newSource.length - 2)
		}
		if (char === "*" && lastChar === "/") {
			stopWriting = true
		}
		if (char === "/" && lastChar === "*") {
			stopWriting = false
		}
		if (char === "\r" || char === "\n") {
			stopWriting = false
		}
		if (!stopWriting) {
			newSource += char
		}
		lastChar = char
	}
	return newSource
}

export async function parseSource(source: string): Promise<ParsedFile> {
	return await parser.parseSource(source)
}

export async function getImports(file: FileSource): Promise<Imports> {
	const parsedSource = await parseSource(file.source)
	const importsRaw = await validateImports(file, parsedSource)
	const imports: Imports = []

	for (let index = 0; index < importsRaw.length; index++) {
		const importRaw = importsRaw[index]
		const path = Path.dirname(file.filePath)
		const fullPath = Path.join(path, importRaw.libraryName)
		if (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx"))
			imports.push(fullPath)

		const tsPath = fullPath + ".ts"
		if (fs.existsSync(tsPath)) imports.push(tsPath)
		const tsxPath = fullPath + ".tsx"
		if (fs.existsSync(tsxPath)) imports.push(tsxPath)
	}

	return imports
}

async function getSubDependencyMap(entryPath:string):Promise<DependencyMap>{
	const entrySource = getSource(entryPath)
	const imports = await getFilesImports([entrySource])
	const importsArray = imports[0].imports
	const subDependencyMap:DependencyMap = new Map();
	for (let index = 0; index < importsArray.length; index++) {
		const element = importsArray[index];
		subDependencyMap.set(element, null);
	}
	return subDependencyMap
}

function checkIfContains(array:string[],element:string):boolean{
	for (let index = 0; index < array.length; index++) {
		const elementArray = array[index];
		if(elementArray === element){
			return true
		}
	}
	return false
}

function getAllKeys(map:Map<string,any>):string[]{
	const keys:string[] = []
	map.forEach((value,key)=>{
		keys.push(key)
	}
	)
	return keys
}

function arrayContains(array:string[],element:string):boolean{
	for (let index = 0; index < array.length; index++) {
		const elementArray = array[index];
		if(elementArray === element){
			return true
		}
	}
	return false
}

async function fillDependencyMap(entryPaths: string[],dependencyMapPointer:DependencyMap,dependents:string[] = []):Promise<void>{
	for (let index = 0; index < entryPaths.length; index++) {
		const entryPath = entryPaths[index]
		const subDependencyMap = await getSubDependencyMap(entryPath)
		const dependencies = getAllKeys(subDependencyMap)
		const currentDependency: Dependency = {
			dependencies: subDependencyMap,
			dependents,
			cycleDetected: []
		}
		dependencyMapPointer.set(entryPath,currentDependency)
		if(dependencies.length){
			for (let index = 0; index < dependencies.length; index++) {
				const dependency = dependencies[index];
				if(arrayContains(dependents,dependency)){
					currentDependency.cycleDetected.push(dependency)
				}
			}
			dependencyMapPointer.set(entryPath,currentDependency)
			if(currentDependency.cycleDetected.length){
				// remove all cycles from dependencies
				for (let index = 0; index < currentDependency.cycleDetected.length; index++) {
					const cycle = currentDependency.cycleDetected[index];
					const indexOfCycle = dependencies.indexOf(cycle)
					if(indexOfCycle !== -1){
						dependencies.splice(indexOfCycle,1)
					}
				}
			}
				const newDependents = [...dependents,...entryPaths] as string[]
				await fillDependencyMap(dependencies,dependencyMapPointer.get(entryPath)?.dependencies as unknown as DependencyMap,newDependents)
		}
	}
}

interface Dependency{
	dependencies:DependencyMap
	dependents:string[]
	cycleDetected:string[]
}
type DependencyMap = Map<string,Dependency | null>

export async function detectImportCycles(entryPaths: string[]) {
	const filesPathsResolved = getResolvedPaths(entryPaths)
	const dependencyMap:DependencyMap = new Map()
	await fillDependencyMap(filesPathsResolved,dependencyMap)
	// get a list of all import cycles
	const cycles = await getImportCycles(dependencyMap)
	// return the list of cycles
	return cycles
}

export function analyzeImportCycles(fileCycles: FileCycles[]): void {
	console.log(`Files that have cycles: ${fileCycles.length} \n`)
	fileCycles.forEach((fileCycle) => {
		console.log(
			`File: ${fileCycle.filePath} contains ${fileCycle.cycle.length} cycles`
		)
		console.log(`\n ==== \n`)
		for (let index = 0; index < fileCycle.cycle.length; index++) {
			const cycle = fileCycle.cycle[index]
			console.log(`${cycle.join("\n")}`)
			if (index < fileCycle.cycle.length - 1) {
				console.log(`\n ----- \n`)
			}
		}
		console.log(`\n ==== \n`)
	})
}

if (process.env.VSCODE_DEBUG) {
	async function debug_test() {
		analyzeImportCycles(
			await detectImportCycles([
				__dirname + "/../examples/test1ClassCycles/entry.ts",
			])
		)
	}
	debug_test()
}
