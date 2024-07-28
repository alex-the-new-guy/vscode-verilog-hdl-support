// SPDX-License-Identifier: MIT
import * as vscode from 'vscode';
import * as child from 'child_process';
import * as path from 'path';
import * as process from 'process';
import BaseLinter from './BaseLinter';
import { Logger } from '../logger';

let isWindows = process.platform === 'win32';

export default class VerilatorLinter extends BaseLinter {
  private configuration: vscode.WorkspaceConfiguration;
  private linterInstalledPath: string;
  private arguments: string;
  private includePath: string[];
  private runAtFileLocation: boolean;
  private useWSL: boolean;

  constructor(diagnosticCollection: vscode.DiagnosticCollection, logger: Logger) {
    super('verilator', diagnosticCollection, logger);
    vscode.workspace.onDidChangeConfiguration(() => {
      this.updateConfig();
    });
    this.updateConfig();
  }

  private updateConfig() {
    this.linterInstalledPath = <string>(
      vscode.workspace.getConfiguration().get('verilog.linting.path')
    );
    this.configuration = vscode.workspace.getConfiguration('verilog.linting.verilator');
    this.arguments = <string>this.configuration.get('arguments');
    let path = <string[]>this.configuration.get('includePath');
    this.includePath = path.map((includePath: string) => this.resolvePath(includePath));
    this.runAtFileLocation = <boolean>this.configuration.get('runAtFileLocation');
    this.useWSL = <boolean>this.configuration.get('useWSL');
  }

  protected splitTerms(line: string) {
    let terms = line.split(':');

    for (var i = 0; i < terms.length; i++) {
      if (terms[i] === ' ') {
        terms.splice(i, 1);
        i--;
      } else {
        terms[i] = terms[i].trim();
      }
    }

    return terms;
  }

  protected convertToSeverity(severityString: string): vscode.DiagnosticSeverity {
    if (severityString.startsWith('Error')) {
      return vscode.DiagnosticSeverity.Error;
    } else if (severityString.startsWith('Warning')) {
      return vscode.DiagnosticSeverity.Warning;
    }
    return vscode.DiagnosticSeverity.Information;
  }

  private convertToWslPath(inputPath: string): string {
    let cmd: string = `wsl wslpath '${inputPath}'`;
    return child.execSync(cmd, {}).toString().replace(/\r?\n/g, '');
  }

  protected lint(doc: vscode.TextDocument) {
    let docUri: string = isWindows
      ? this.useWSL
        ? this.convertToWslPath(doc.uri.fsPath)
        : doc.uri.fsPath.replace(/\\/g, '/')
      : doc.uri.fsPath;
    let docFolder: string = isWindows
      ? this.useWSL
        ? this.convertToWslPath(path.dirname(doc.uri.fsPath))
        : path.dirname(doc.uri.fsPath).replace(/\\/g, '/')
      : path.dirname(doc.uri.fsPath);
    let cwd: string = this.runAtFileLocation
      ? isWindows
        ? path.dirname(doc.uri.fsPath.replace(/\\/g, '/'))
        : docFolder
      : vscode.workspace.workspaceFolders[0].uri.fsPath;
    let verilator: string = isWindows
      ? this.useWSL
        ? 'wsl verilator'
        : 'verilator_bin.exe'
      : 'verilator';

    let binPath = path.join(this.linterInstalledPath, verilator);
    let args: string[] = [];
    if (doc.languageId === 'systemverilog') {
      args.push('-sv');
    }
    args.push('--lint-only');
    args.push(`-I"${docFolder}"`);
    args = args.concat(this.includePath.map((path: string) => `-I"${path}"`));
    args.push(this.arguments);
    args.push(`"${docUri}"`);
    let command: string = binPath + ' ' + args.join(' ');

    this.logger.info('[verilator] Execute');
    this.logger.info('[verilator]   command: ' + command);
    this.logger.info('[verilator]   cwd    : ' + cwd);



    var _: child.ChildProcess = child.exec(
      command,
      { cwd: cwd },
      (_error: Error, _stdout: string, stderr: string) => {

        // basically DiagnosticsCollection but with ability to append diag lists
        let filesDiag = new Map();

        stderr.split(/\r?\n/g).forEach((line, currentLineNumber, stderrLines) => {


          // if lineIndex is 0 and it doesn't start with %Error or %Warning,
          // the whole loop would skip
          // and it is probably a system error (wrong file name/directory/something)
          let lastDiagMessageType: string = "Error";

          // parsing previous lines for message type
          // shouldn't be more than 5 or so
          for (let lineIndex = currentLineNumber; lineIndex >= 0; lineIndex--)
          {
            if (stderrLines[lineIndex].startsWith("%Error"))
            {
              lastDiagMessageType = "Error";
              break;
            }
            if (stderrLines[lineIndex].startsWith("%Warning"))
            {
              lastDiagMessageType = "Warning";
              break;
            }
          }

          // first line would be normal stderr output like "directory name is invalid"
          // others are verilator sort of "highlighting" the issue, the block with "^~~~~"
          // this can actually be used for better error/warning highlighting

          // also this might have some false positives
          // probably something like "stderr passthrough setting" would be a good idea
          if (!line.startsWith('%')) {
            
            // allows for persistent 
            if (lastDiagMessageType === 'Warning') { this.logger.warn(line); }
              else { this.logger.error(line); }
            return;
          }


          // important match sections are named now:
          // severity - Error or Warning
          // errorCode - error code, if there is one, something like PINNOTFOUND
          // filePath - full path to the file, including it's name and extension
          // lineNumber - line number
          // columNumber - columnNumber
          // verboseError - error elaboration by verilator

          const errorParserRegex = new RegExp(
            /%(?<severity>\w+)/.source + // matches "%Warning" or "%Error"

            // this matches errorcode with "-" before it, but the "-" doesn't go into ErrorCode match group
            /(-(?<errorCode>[A-Z0-9]+))?/.source + // matches error code like -PINNOTFOUND

            /: /.source + // ": " before file path or error message
            
            // this one's a bit of a mess, but apparently one can't cleanly split regex match group between lines
            // and this is a large group since it matches file path and line and column numbers which may not exist at all

            // note: end of file path is detected using file extension at the end of it
            // this also allows for spaces in path.
            // (neiter Linux, nor Windows actually prohibits it, and Verilator handles spaces just fine)
            // In my testing, didn't lead cause any problems, but it potentially can
            // extension names are placed so that longest one is first and has highest priority

            /((?<filePath>(\S| )+(?<fileExtension>(\.svh)|(\.sv)|(\.SV)|(\.vh)|(\.vl)|(\.v))):((?<lineNumber>\d+):)?((?<columnNumber>\d+):)? )?/.source +

            // matches error message produced by Verilator
            /(?<verboseError>.*)/.source
            , "g"
          );

          let rex = errorParserRegex.exec(line);

          // stderr passthrough
          // probably better toggled with a parameter
          if (rex.groups["severity"] === "Error") { this.logger.error(line); }
            else if (rex.groups["severity"] === "Warning") { this.logger.warn(line); }

            // theoretically, this shoudn't "fire", but just in case
            else { this.logger.error(line); }

          


          // vscode problems are tied to files
          // if there isn't a file name, no point going further
          if (!rex.groups["filePath"]) {
            return;
          }
          
          // replacing "\\" and "\" with "/" for consistency
          if (isWindows)
          {
            rex.groups["filePath"] = rex.groups["filePath"].replace(/(\\\\)|(\\)/g, "/");
          }

          // if there isn't a list of errors for this file already, it
          // needs to be created
          if (!filesDiag.has(rex.groups["filePath"]))
          {
            filesDiag.set(rex.groups["filePath"], []);
          }
          

          if (rex && rex[0].length > 0) {
            let lineNum = Number(rex.groups["lineNumber"]) - 1;
            let colNum = Number(rex.groups["columnNumber"]) - 1;

            colNum = isNaN(colNum) ? 0 : colNum; // for older Verilator versions (< 4.030 ~ish)

            let endColNum = Number.MAX_VALUE;

            let relatedInfoMsg: string[] = [];

            // verilator may output additional messages after the first one
            // this regex parses them
            const topRelatedInfoRegex = /\s+: \.\.\. (?<verboseError>(\S| )+)/;

            // number of additional messages shouldn't be that large, but this 
            // handles arbirary amount and checks for array end
            for (let additionalMessageCounter: number = 1;
              currentLineNumber + additionalMessageCounter < stderrLines.length;
              additionalMessageCounter++
            )
            {
              const additionalMessageLine = stderrLines.at(currentLineNumber + additionalMessageCounter);

              // additional messages come after main one, so if we get anything else,
              // there is no more of them
              if (!topRelatedInfoRegex.test(additionalMessageLine))
              {
                break;
              }

              relatedInfoMsg.push(
                topRelatedInfoRegex.exec(additionalMessageLine).groups["verboseError"]
              );
            }

            // should be one section per error, so no need for tags
            // highlight can be just "^" so the number of "~"s is between 0 and line length -1
            const highlightRegex = /\|\s+(?<highlight>\^~*)/;


            // highlight section comes after additional messages and
            // potentially, a constant offset can be used, but i've had issues with it
            // usually, the first string in loop should be the one with highlight

            // start offset should be 2 because generally
            // 0 | <error message> <- currentLineIndex
            // 1 | <string at which error has occured>
            // 2 | <highlight line>
            // but is left at 1 because 1 could be next error message, which would
            // be missed by condition that checks for it. Cheap insurance.
            for (let highlightTestOffset = 1;
              currentLineNumber + highlightTestOffset < stderrLines.length;
              highlightTestOffset++
            )
            {
              const currentTestLine = stderrLines.at(currentLineNumber + highlightTestOffset);

              // reached start of next message
              if (currentTestLine.startsWith("%")) {break;}

              // there should be only one or none highlights in message block
              // so either it is the first one that is found, or none, in which case
              // the default value is passed through
              if (highlightRegex.test(currentTestLine))
              {
                const highlightString = highlightRegex.exec(currentTestLine).groups["highlight"];
                endColNum = colNum + highlightString.length;
                break;
              }
            }

            // regex that matches "bottom" error messages that come after highlight block
            // and provide additional info, such as what file includes the file from which
            // the message originates
            // const bottomMessageRegex = RegExp(
            //   /\s+/.source + //matches spaces at the beginning

            //   // parses additional info message, fairly similar to main parser regex
            //   /((?<filePath>(\S| )+(?<fileExtension>(\.svh)|(\.sv)|(\.SV)|(\.vh)|(\.vl)|(\.v))):(?<lineNumber>\d+):(?<columnNumber>\d+):)?/.source +

            //   // parses the error message itself
            //   / \.\.\. (?<verboseError>(\S| )+)/,
            //   "g"
            // );

            const bottomMessageRegex = /\s+((?<filePath>(\S| )+(?<fileExtension>(\.svh)|(\.sv)|(\.SV)|(\.vh)|(\.vl)|(\.v))):(?<lineNumber>\d+):(?<columnNumber>\d+):)? \.\.\. (?<verboseError>(\S| )+)/;



            // theese messages can have unique ranges
            let bottomMessages: vscode.DiagnosticRelatedInformation[] = [];

            for (let bottomMessageLineOffset = 1;
              currentLineNumber + bottomMessageLineOffset < stderrLines.length;
              bottomMessageLineOffset++
            )
            {
              const currentTestLine = stderrLines.at(currentLineNumber + bottomMessageLineOffset);

              // reached start of next message
              if (currentTestLine.startsWith("%")) {break;}

              // indicates current line contains bottom message
              const isBottomMessage = bottomMessageRegex.test(currentTestLine);

              // indicates current line contains bottom message highlight
              // note: since all loops start as offset 1 to not miss next message,
              // highlight regex will also match main highlight, since they are formed the same way
              // buit bottomMessages.length == 0 does indicate we're not parsing bottom messages yet
              const isBottomHighlight = bottomMessages.length > 0 && highlightRegex.test(currentTestLine);

              if (isBottomMessage)
              {
                const matched = bottomMessageRegex.exec(currentTestLine);

                // if message doesn't have it's own location, it is assumed it's location is the same
                // as current main message's

                let currentMessageLocation: vscode.Location;

                // assuming if file location is provided,
                // there is also line and column numbers
                if (matched.groups["filePath"]) {

                  const currentMessageFile = vscode.Uri.file(matched.groups["filePath"]);

                  const currentMessageRange = new vscode.Range(
                    Number(matched.groups["lineNumber"]) - 1,
                    Number(matched.groups["columnNumber"]) - 1,
                    Number(matched.groups["lineNumber"]) - 1,
                    Number.MAX_VALUE
                  );

                  currentMessageLocation = new vscode.Location(currentMessageFile, currentMessageRange);

                } else {
                  const currentMessageFile = vscode.Uri.file(rex.groups["filePath"]);

                  const currentMessageRange = new vscode.Range(lineNum, colNum, lineNum, endColNum);

                  currentMessageLocation = new vscode.Location(currentMessageFile, currentMessageRange);
                }

                const currentMessage = matched.groups["verboseError"]
                bottomMessages.push(
                  new vscode.DiagnosticRelatedInformation(
                    currentMessageLocation,
                    currentMessage
                  )
                );
              }

              // parsing highlight for last bottom message
              if (isBottomHighlight)
              {
                const highlightString = highlightRegex.exec(currentTestLine).groups["highlight"];

                // no need to change start position
                const newStart = bottomMessages[bottomMessages.length -1].location.range.start;

                // since highlights are single-line, no need only highlight length
                // needs to be adjusted 
                const newEnd = new vscode.Position(
                  newStart.line,
                  newStart.character + highlightString.length
                );

                let newRange: vscode.Range = new vscode.Range(
                  newStart,
                  newEnd
                );

                // need to update range since all further members are readonly
                bottomMessages[bottomMessages.length -1].location.range = newRange;
              }
            }


            // template for diagnostics that share location and Verilator outputs together
            // additional ones look line "        : ... <message>"
            // they all presumably refer to same portion of the code, but additional messages
            // don't have error codes
            const diagTemplate: vscode.Diagnostic = {
              severity: this.convertToSeverity(rex.groups["severity"]),
              range: new vscode.Range(lineNum, colNum, lineNum, endColNum),
              message: "",
              source: 'verilator',
            };

            if (isNaN(lineNum)) {return;}
            
            // filling fields for main message
            let mainMessageDiag = Object.assign({}, diagTemplate);
            mainMessageDiag.code = rex.groups["errorCode"];
            mainMessageDiag.message = rex.groups["verboseError"];

            // pushing main message
            filesDiag.get(rex.groups["filePath"]).push(mainMessageDiag);

            const currentMsgLocation = new vscode.Location(
              vscode.Uri.file(rex.groups["filePath"]),
              mainMessageDiag.range
            );

            mainMessageDiag.relatedInformation = [];
            
            mainMessageDiag.relatedInformation = mainMessageDiag.relatedInformation.concat(bottomMessages);


            // pushing additional messages
            relatedInfoMsg.forEach(message => {
              mainMessageDiag.relatedInformation.push(
                new vscode.DiagnosticRelatedInformation(currentMsgLocation, message)
              );
            });
            
            return;
          }
        });

        // since error parsing has been redone "from the ground up"
        // earlier errors are discarded
        this.diagnosticCollection.clear();

        filesDiag.forEach((issuesArray, fileName) =>
          {
            let fileURI = vscode.Uri.file(fileName);
            this.diagnosticCollection.set(
              fileURI,
              issuesArray
            );
          }
        );
      }
    );
  }
}
