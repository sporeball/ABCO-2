/*
  index.js
  diverged from bd0edaa
*/

import tokenize from './tokenizer.js';
import parse from './parser.js';
// import * as Assembler from './index.js';

const editor = document.getElementById('editor');
const canvas = document.getElementById('canvas');
const ctx = document.getElementById('canvas').getContext('2d');
let timeout;

function assembler () {
  // pollution
  window.ASM = {
    bytes: '',
    ptr: 0,
    labels: {},
    macros: {}
  };

  let contents = editor.content;

  contents = contents.split('\n')
    .map(line => line.replace(/;.*/gm, '').trim()); // clean

  if (contents.at(-1).length === 0) {
    contents = contents.slice(0, -1);
  }

  contents = contents.join('\n');
  const tokens = tokenize(contents);
  const AST = parse(tokens);

  // all top-level nodes in the AST should be either a number, a command, or
  // some sort of definition
  const invalid = AST.find(topLevelNode => {
    return (
      topLevelNode.type !== 'number' &&
      topLevelNode.type !== 'command' &&
      topLevelNode.type !== 'labelDefinition' &&
      topLevelNode.type !== 'macroDefinition'
    );
  });
  if (invalid) {
    throw new Error(`found bare token of type ${invalid.type}`);
  }

  // step 1: determine length of macros
  // grab from the AST
  for (const macro of AST.filter(tln => tln.type === 'macroDefinition')) {
    const { name, params, contents } = macro;
    // get the total length of node contents
    const length = contents.map(nodeLength)
      .reduce((a, c) => a + c, 0);
    // intermediate value
    window.ASM.macros[name] = {
      params,
      contents,
      length,
      uses: 0
    }
  }

  // step 2: determine local label addresses
  for (const macro of Object.values(window.ASM.macros)) {
    let ptr = 0;
    macro.labels = {};
    for (const node of macro.contents) {
      ptr += nodeLength(node);
      if (node.type === 'macroLabelDefinition') {
        macro.labels[node.name] = ptr;
      }
    }
  }

  // step 3: determine global label addresses
  for (const topLevelNode of AST) {
    window.ASM.ptr += nodeLength(topLevelNode);
    if (topLevelNode.type === 'labelDefinition') {
      window.ASM.labels[topLevelNode.name] = window.ASM.ptr;
    }
  }

  // console.log(global.ASM.labels);
  // console.log(global.ASM.macros);

  // step 4: create program bytecode
  window.ASM.ptr = 0;
  for (const command of AST.filter(tln => {
    return tln.type === 'number' || tln.type === 'command';
  })) {
    // console.log(command);
    const ptr = window.ASM.ptr;
    genBytecode(command, ptr);
  }

  // finished
  // pad with null bytes
  window.ASM.bytes += String.fromCharCode(0x00)
    .repeat(0x100FF - window.ASM.bytes.length);
}

function simulator () {
  canvas.width = 256;
  canvas.height = 192;
  // const user = Array(65791).fill(0);
  const user = [...window.ASM.bytes].map(b => b.charCodeAt(0));
  let ptr = 0;

  for (let i = 0; i < 10000; i++) {
    if (ptr === 65529) {
      break;
    }

    let A = 0;
    let B = 0;
    let C = 0;

    A += user[ptr] * 65536;
    ptr++;
    A += user[ptr] * 256;
    ptr++;
    A += user[ptr];
    ptr++;
    B += user[ptr] * 65536;
    ptr++;
    B += user[ptr] * 256;
    ptr++;
    B += user[ptr];
    ptr++;
    C += user[ptr] * 65536;
    ptr++;
    C += user[ptr] * 256;
    ptr++;
    C += user[ptr];

    // console.log(A, B, C);

    user[A] += user[B];
    if (user[A] > 255) {
      user[A] %= 256;
      ptr = C;
    } else {
      ptr++;
    }

    // screen device
    if (A === 0x10000) {
      user[0x10000] = 0;
      // TODO: 4 colors
      switch (user[0x10003]) {
        case 0:
          ctx.fillStyle = '#fff';
          break;
        case 1:
          ctx.fillStyle = '#000';
          break;
        default:
          ctx.fillStyle = '#000';
      }
      ctx.fillRect(user[0x10001], user[0x10002], 1, 1);
    }
  }
}

/**
 * generate the bytecode for an AST node
 * @param {object} ASTNode
 */
export function genBytecode (ASTNode, macroStart, macroLabels, macroParameters, macroName, macroUses) {
  // console.log('node', ASTNode);
  let args = structuredClone(ASTNode.args);
  args = (args || []).map(arg => {
    return argNodeToValue(arg, macroStart, macroLabels, macroParameters, macroName, macroUses);
  });
  // console.log('args:', args);
  if (ASTNode.type === 'number') {
    byteWrite(false, ASTNode.value);
    window.ASM.ptr += 3;
  }
  else if (ASTNode.head === 'abcout') {
    byteWrite(true, ...args);
    if (args.length === 2) {
      byteWrite(true, window.ASM.ptr + 9);
    }
    window.ASM.ptr += 9;
  } else {
    const macro = window.ASM.macros[ASTNode.head];
    macro.uses++;
    let ptr = window.ASM.ptr;
    const labels = uniqueLabels(ASTNode.head, macro.uses, macro.labels, ptr);
    const name = ASTNode.head;
    const uses = macro.uses;
    // console.log('assembling', ASTNode.head);
    // console.log('args', args);
    // console.log('length', macro.length);
    // console.log('labels', labels);
    // console.log('macro start', macroStart);
    for (const node of macro.contents.filter(node => node.type === 'command')) {
      genBytecode(node, ptr, labels, args, name, uses);
      ptr = window.ASM.ptr;
    }
  }
}

function uniqueLabels(name, uses, labels, ptr) {
  let newLabels = {};
  for (const entry of Object.entries(labels)) {
    const [label, value] = entry;
    newLabels[`${name}.${label}.${uses}`] = value + ptr;
  }
  return newLabels;
}

function argNodeToValue (arg, macroStart, macroLabels, macroParameters, macroName, macroUses) {
  if (typeof arg === 'number') {
    return arg;
  }
  if (arg.type === 'number') {
    return arg.value;
  }
  if (arg.type === 'label') {
    const value = window.ASM.labels[arg.name];
    if (value === undefined) {
      throw new Error(`assembler: undefined label ${arg.name}`);
    }
    return value;
  }
  if (arg.type === 'macroLabel') {
    if (macroLabels === undefined) {
      throw new Error(`assembler: undefined local label ${arg.name}`);
    }
    const value = macroLabels[`${macroName}.${arg.name}.${macroUses}`];
    if (value === undefined) {
      throw new Error(`assembler: undefined local label ${arg.name}`);
    }
    // console.log('macro label', arg.name, value + macroStart);
    return value;
  }
  if (arg.type === 'macroParameter') {
    if (macroParameters === undefined) {
      throw new Error(
        `assembler: could not get macro parameter at index ${arg.index}`
      );
    }
    const value = macroParameters[arg.index];
    if (value === undefined) {
      throw new Error(
        `assembler: could not get macro parameter at index ${arg.index}`
      );
    }
    return value;
  }
}

export function nodeLength (ASTNode) {
  switch (ASTNode.type) {
    case 'number':
      if (ASTNode.value > 65535) {
        return 3;
      }
      if (ASTNode.value > 255) {
        return 2;
      }
      return 1;
    case 'command':
      if (ASTNode.head === 'abcout') {
        return 9;
      }
      const macro = window.ASM.macros[ASTNode.head];
      if (macro === undefined) {
        throw new Error(`assembler: undefined macro ${ASTNode.head}`);
      }
      return macro.contents
        .map(nodeLength)
        .reduce((a, c) => a + c, 0);
    default:
      return 0;
  }
}

function byteWrite (nulls, ...values) {
  for (const value of values) {
    if (value > 65535) {
      window.ASM.bytes += String.fromCharCode(value >> 16);
      window.ASM.bytes += String.fromCharCode((value & ~(0xFF0000)) >> 8);
      window.ASM.bytes += String.fromCharCode(value & 255); // lower 8 bits
    } else if (value > 255) {
      if (nulls) {
        window.ASM.bytes += String.fromCharCode(0x00);
      }
      window.ASM.bytes += String.fromCharCode(value >> 8); // upper 8 bits
      window.ASM.bytes += String.fromCharCode(value & 255); // lower 8 bits
    } else {
      if (nulls) {
        window.ASM.bytes += String.fromCharCode(0x00);
        window.ASM.bytes += String.fromCharCode(0x00);
      }
      window.ASM.bytes += String.fromCharCode(value);
    }
  }
}

// main code
editor.oninput = function () {
  window.clearTimeout(timeout);
  timeout = window.setTimeout(function () {
    try {
      assembler();
      simulator();
    } catch (e) {
      // TODO: use the custom log
      console.log(e);
    }
  }, 2000);
}

