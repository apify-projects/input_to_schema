"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.multiActorJsonToTypes = exports.getSchemaFromSourcePathMultiple = exports.getSchemaFromSourcePath = exports.convertSchemaToType = exports.convertJsDoccableToString = void 0;
const tslib_1 = require("tslib");
const fs_1 = tslib_1.__importDefault(require("fs"));
const path_1 = tslib_1.__importDefault(require("path"));
const arktype = tslib_1.__importStar(require("arktype"));
const commander_1 = require("commander");
const typescript_1 = tslib_1.__importDefault(require("typescript"));
const findSyntaxKind = (statement, kind) => {
    if (statement.kind === kind) {
        return statement;
    }
    return statement.getChildren().find((child) => findSyntaxKind(child, kind));
};
const JSDOC_PROPS_TO_EVAL = ["default", "prefill", "minimum", "maximum", "enumTitles", "schemaVersion", "required"];
function getJsDocFromNode(checker, rawNode) {
    const output = {};
    const node = rawNode.getFullText ? rawNode : rawNode.valueDeclaration;
    const jsDocRegex = new RegExp(/@(\w+)\s+((?:.*(?:\n(?!\s*\*\s*@|\s*\*\/).*)*))/mg);
    let matches;
    while ((matches = jsDocRegex.exec(node.getFullText().slice(0, node.getLeadingTriviaWidth()))) !== null) {
        const [, name, value,] = matches;
        output[name] = value.replace(/\n\t\s*\*/g, '');
        if (JSDOC_PROPS_TO_EVAL.includes(name)) {
            try {
                output[name] = eval(output[name]);
            }
            catch (e) {
                console.error(name, "with value", JSON.stringify(output[name]), "couldnt be evaluated because", e);
                process.exit(1);
            }
        }
    }
    return output;
}
function convertInputIntoSchema(checker, node) {
    const type = checker.getTypeAtLocation(node);
    const schema = convertObjectToSchema(checker, type, {}, []);
    // @ts-ignore
    delete schema.editor;
    return {
        ...getJsDocFromNode(checker, node),
        ...schema
    };
}
function convertEnumlikeIntoEnum(checker, enumlike) {
    // @ts-ignore
    return enumlike.types.map((type) => type.value);
}
function convertEnumlikeIntoSchema(checker, enumlike, doc) {
    const schema = {
        // TODO: actual type inference
        type: 'string',
        editor: 'select',
        enum: convertEnumlikeIntoEnum(checker, enumlike),
        ...doc
    };
    return schema;
}
function convertJSDocToSchema(checker, symbol) {
    const JSDocInfoValidator = arktype.type({
        'title?': 'string',
        'description?': 'string',
        'editor?': 'string',
        'default?': 'string',
        'prefill?': 'string | string[]',
        'enumTitles?': 'string[]',
        'sectionCaption?': 'string',
        'sectionDescription?': 'string',
        'required?': 'string'
    });
    const jsDoc = symbol.getJsDocTags(checker);
    const collectedJsDoc = {};
    for (const tag of jsDoc) {
        if (tag.text) {
            collectedJsDoc[tag.name] = tag.text[0].text.replace(/"/g, '').trim();
        }
    }
    const { data: validatedJsDoc, problems } = JSDocInfoValidator(collectedJsDoc);
    if (problems) {
        console.warn(problems);
    }
    return {
        ...validatedJsDoc,
    };
}
function convertPrimitiveToSchema(checker, type, doc) {
    if (type.flags & typescript_1.default.TypeFlags.String) {
        return {
            ...doc,
            type: 'string',
            editor: doc.editor || 'textfield',
        };
    }
    if (type.flags & typescript_1.default.TypeFlags.Number) {
        return {
            ...doc,
            type: 'integer',
            editor: doc.editor || 'number',
        };
    }
    if (type.flags & typescript_1.default.TypeFlags.Boolean) {
        return {
            ...doc,
            type: 'boolean',
            editor: doc.editor || 'checkmark',
        };
    }
    return {
        ...doc,
        type: 'string',
        editor: doc.editor || 'textfield',
    };
}
function convertArrayToSchema(checker, array, doc) {
    return {
        type: 'array',
        editor: 'textfield',
        ...doc,
        uniqueItems: doc.uniqueItems && eval(doc.uniqueItems)
    };
}
function convertObjectToSchema(checker, object, doc, propertyPath) {
    if (checker.isArrayType(object))
        return convertArrayToSchema(checker, object, doc);
    const schema = {};
    const required = [];
    const properties = object.getProperties();
    for (const property of properties) {
        // const propertyDoc = convertJSDocToSchema(checker, property);
        const propertyDoc = getJsDocFromNode(checker, property);
        const propertySchema = convertTypeToSchema(checker, checker.getTypeOfSymbol(property), propertyDoc, [...propertyPath, property.name]);
        if (
        // !(property.flags & ts.SymbolFlags.Optional) && propertySchema.default === undefined && propertySchema.editor !== 'hidden' && propertySchema.required
        propertySchema.required) {
            required.push(property.name);
        }
        schema[property.name] = propertySchema;
    }
    return {
        type: 'object',
        editor: 'textfield',
        properties: schema,
        ...doc,
        required,
    };
}
function convertTypeToSchema(checker, type, doc, propertyPath) {
    if (type.flags & typescript_1.default.TypeFlags.Enum
        || type.flags & typescript_1.default.TypeFlags.EnumLike
        || type.flags & typescript_1.default.TypeFlags.EnumLiteral
        || (type.flags & typescript_1.default.TypeFlags.Union && !(type.flags & typescript_1.default.TypeFlags.Boolean))) {
        return convertEnumlikeIntoSchema(checker, type, doc);
    }
    if (type.flags & typescript_1.default.TypeFlags.Object) {
        return convertObjectToSchema(checker, type, doc, propertyPath);
    }
    if (!(type.flags & typescript_1.default.TypeFlags.NonPrimitive)) {
        return convertPrimitiveToSchema(checker, type, doc);
    }
    process.exit(1);
}
function convertJsDoccableToString(value, required, level = 0) {
    const padding = '\t'.repeat(level);
    let output = '';
    output += `${padding}/**\n`;
    for (const [jsDoccableName, jsDoccableValue] of Object.entries(value)) {
        if (jsDoccableName === 'type')
            continue;
        if (jsDoccableName === 'enum')
            continue;
        if (jsDoccableName === 'properties')
            continue;
        if (jsDoccableName !== 'required' && jsDoccableValue === '')
            continue;
        let formattedValue = jsDoccableValue;
        if (JSDOC_PROPS_TO_EVAL.includes(jsDoccableName)) {
            if (required && jsDoccableName === 'required') {
                formattedValue = '';
            }
            else if (!required && jsDoccableName === 'required') {
                continue;
            }
            else if (value.type === 'string' && ["default", "prefill"].includes(jsDoccableName)) {
                formattedValue = `"${formattedValue}"`;
            }
            else {
                formattedValue = JSON.stringify(formattedValue);
            }
        }
        output += `${padding} * @${jsDoccableName} ${formattedValue}\n`;
    }
    if (required) {
        output += `${padding} * @required true\n`;
    }
    output += `${padding} */\n`;
    return output;
}
exports.convertJsDoccableToString = convertJsDoccableToString;
function convertSchemaToType(name, schema, required = false, level = 0) {
    const padding = '\t'.repeat(level);
    // @ts-ignore
    if (schema.type === 'integer') {
        // @ts-ignore
        schema.type = 'number';
    }
    // @ts-ignore
    if (schema.type === 'array') {
        if (schema.editor === 'stringList') {
            // @ts-ignore
            schema.type = 'string[]';
        }
        else {
            // @ts-ignore
            schema.type = 'any[]';
        }
    }
    if (schema.type === 'object') {
        let output = '';
        const jsDoccable = JSON.parse(JSON.stringify(schema));
        const { properties, required } = schema;
        output += convertJsDoccableToString(jsDoccable, false, level);
        output += `type ${name} = {\n`;
        for (const [name, property] of Object.entries(properties)) {
            output += `${convertSchemaToType(name, property, required.includes(name), level + 1)}\n\n`;
        }
        return `${output}}`;
    }
    let output = '';
    const jsDoccable = JSON.parse(JSON.stringify(schema));
    output += convertJsDoccableToString(jsDoccable, required, level);
    const requiredString = jsDoccable.default !== undefined ? '?' : '';
    // @ts-ignore
    if (jsDoccable?.enum) {
        // @ts-ignore
        output += `${padding}${name}${requiredString}: ${jsDoccable?.enum.map((each) => `'${each}'`).join(' | ')}`;
    }
    else {
        output += `${padding}${name}${requiredString}: ${schema.type}`;
    }
    return output;
}
exports.convertSchemaToType = convertSchemaToType;
function loadProgram(sourcePath, inputFileName) {
    const files = fs_1.default.readdirSync(sourcePath).map((file) => path_1.default.join(sourcePath, file));
    const inputFilePath = files.find((file) => file.includes(inputFileName));
    if (!inputFilePath) {
        console.error(`Couldn't find any '${inputFileName}' file in '${sourcePath}'.`);
        process.exit(1);
    }
    const program = typescript_1.default.createProgram(files, { baseUrl: sourcePath });
    const sourceFile = program.getSourceFile(inputFilePath);
    if (!sourceFile) {
        console.error("Couldn't load source program");
        process.exit(1);
    }
    return { program, sourceFile };
}
function getSchemaFromSourcePath(sourcePath, inputFileName, typeName) {
    const { program, sourceFile } = loadProgram(sourcePath, inputFileName);
    const checker = program.getTypeChecker();
    const { inputNode, inputDefaults } = getDefaultsFromInputAssign(checker, sourceFile, typeName);
    if (!inputNode) {
        console.error(`No '${typeName}' type found in the supplied file.`);
        process.exit(1);
    }
    const schema = convertInputIntoSchema(checker, inputNode);
    if (!inputDefaults) {
        // console.warn(`No defaults found for '${typeName}'`);
        return cleanUpSchema(schema);
    }
    return cleanUpSchema(schema);
}
exports.getSchemaFromSourcePath = getSchemaFromSourcePath;
function getSchemaFromSourcePathMultiple(sourcePath, inputFileName, pattern) {
    const { program, sourceFile } = loadProgram(sourcePath, inputFileName);
    const checker = program.getTypeChecker();
    const { inputNodes } = getDefaultsFromInputAssignMultiple(checker, sourceFile, pattern);
    if (!inputNodes.length) {
        console.error(`No '${pattern}' type found in the supplied file.`);
        process.exit(1);
    }
    return inputNodes
        .map((inputNode) => convertInputIntoSchema(checker, inputNode))
        .map((schema) => cleanUpSchema(schema));
}
exports.getSchemaFromSourcePathMultiple = getSchemaFromSourcePathMultiple;
function getDefaultsFromInputAssign(checker, sourceFile, typeName) {
    let inputNode;
    let inputDefaults;
    for (const child of sourceFile.statements) {
        const resultVD = findSyntaxKind(child, typescript_1.default.SyntaxKind.VariableDeclaration);
        if (!resultVD)
            continue;
        const { initializer } = resultVD;
        if (!initializer)
            continue;
        if (initializer.name.escapedText !== typeName && initialized.name.escapedText !== typeName)
            continue;
        const defaults = findSyntaxKind(child, typescript_1.default.SyntaxKind.ObjectBindingPattern);
        if (!defaults)
            continue;
        inputNode = initializer;
        inputDefaults = defaults.elements.filter((element) => element.initializer);
        break;
    }
    if (!inputNode) {
        for (const child of sourceFile.statements) {
            let found = findSyntaxKind(child, typescript_1.default.SyntaxKind.InterfaceDeclaration);
            if (!found) {
                found = findSyntaxKind(child, typescript_1.default.SyntaxKind.TypeAliasDeclaration);
            }
            if (!found)
                continue;
            if (found.name.escapedText !== typeName)
                continue;
            if (found) {
                inputNode = found;
                break;
            }
        }
    }
    return { inputNode, inputDefaults };
}
function getDefaultsFromInputAssignMultiple(checker, sourceFile, pattern) {
    const alreadyProcessed = [];
    const inputNodes = [];
    for (const child of sourceFile.statements) {
        const refreshedPattern = new RegExp(pattern);
        let found = findSyntaxKind(child, typescript_1.default.SyntaxKind.InterfaceDeclaration);
        if (!found) {
            found = findSyntaxKind(child, typescript_1.default.SyntaxKind.TypeAliasDeclaration);
        }
        if (!found)
            continue;
        if (!refreshedPattern.test(found.name.escapedText) && !alreadyProcessed.includes(found.name.escapedText))
            continue;
        alreadyProcessed.push(found.name.escapedText);
        inputNodes.push(found);
    }
    return { inputNodes, inputDefaults: [] };
}
function cleanUpSchema(schema) {
    if (schema.type === 'object') {
        const properties = schema.properties;
        for (const name in properties) {
            cleanUpSchema(properties[name]);
        }
    }
    if (schema.type !== 'object') {
        delete schema.required;
    }
    for (const key in schema) {
        if (schema[key] === undefined)
            delete schema[key];
    }
    return schema;
}
commander_1.program
    .command('type-to-json')
    .argument('<source>')
    .option('--typeName <name>', 'custom Input type name', 'Input')
    .option('--inputFileName <name>', 'name of the file containing Input definition', 'main.ts')
    .action((source, options) => {
    const schema = getSchemaFromSourcePath(source, options.inputFileName, options.typeName);
    console.log(schema);
    const json = JSON.stringify(schema, undefined, 4);
    console.log(json);
});
commander_1.program
    .command('multiactor-type-to-json')
    .argument('<source>')
    .option('--inputFile <inputFile>', 'Input file', 'input.ts')
    .option('--typeRegex <regex>', 'Input type regex', '.*Input')
    .option('--ignoreSpecificType <ignoredTypeName>', 'Input type to ignore', '')
    .option('--write <folder>', 'A folder to write the output to', '')
    .action((source, options) => {
    const schemas = getSchemaFromSourcePathMultiple(source, options.inputFile, new RegExp(options.typeRegex));
    for (const schema of schemas) {
        if (options.write) {
            const inputSchemaPath = `${options.write}/${schema.id}`;
            if (!fs_1.default.existsSync(inputSchemaPath)) {
                fs_1.default.mkdirSync(inputSchemaPath);
            }
            fs_1.default.writeFileSync(`${inputSchemaPath}/INPUT_SCHEMA.json`, JSON.stringify(schema, null, 4), 'utf8');
        }
        else {
            console.log(JSON.stringify(schema, null, 4));
        }
    }
});
commander_1.program
    .command('json-to-type')
    .argument('<source>')
    .action((source) => {
    console.log(convertSchemaToType('Input', JSON.parse(fs_1.default.readFileSync(source, 'utf8'))));
});
const camelize = (s) => {
    const camelized = s.replace(/-./g, (x) => x[1].toUpperCase()).split('');
    camelized[0] = camelized[0].toUpperCase();
    return camelized.join('');
};
function multiActorJsonToTypes(actorsFolder) {
    const actorsDirs = fs_1.default.readdirSync(actorsFolder);
    const schemas = [];
    for (const actorsDir of actorsDirs) {
        const files = fs_1.default.readdirSync(`${actorsFolder}/${actorsDir}/.actor/`);
        let schemaPath = files.find((file) => file.includes('INPUT_SCHEMA.json'));
        if (!schemaPath) {
            const actorFile = files.find((file) => file.includes('actor.json'));
            const actorInfo = JSON.parse(fs_1.default.readFileSync(`${actorsFolder}/${actorsDir}/.actor/${actorFile}`, 'utf8'));
            schemaPath = actorInfo.input;
        }
        schemas.push({
            name: camelize(actorsDir.split('/').slice(-1)[0]),
            id: actorsDir.split('/').slice(-1)[0],
            schema: JSON.parse(fs_1.default.readFileSync(`${actorsFolder}/${actorsDir}/.actor/${schemaPath}`, 'utf8')),
        });
    }
    const types = schemas
        .map(schema => convertSchemaToType(`${schema.name}Input`, {
        ...schema.schema,
        id: schema.id
    }));
    return types;
}
exports.multiActorJsonToTypes = multiActorJsonToTypes;
commander_1.program
    .command('multiactor-json-to-type')
    .argument('<actorsFolder>')
    .option('--write <file>')
    .action((actorsFolder, options) => {
    const inputTypesStrings = multiActorJsonToTypes(actorsFolder);
    if (options.write) {
        fs_1.default.writeFileSync(options.write, inputTypesStrings.join('\n'));
    }
    else {
        console.log(inputTypesStrings.join('\n'));
    }
});
if (process.env.MODE !== 'test') {
    commander_1.program.parse();
}
//# sourceMappingURL=index.js.map