import { IDE } from "core";
import {
  AutocompleteInput,
  CompletionProvider,
} from "core/autocomplete/completionProvider";
import { ConfigHandler } from "core/config/handler";
import { logDevData } from "core/util/devdata";
import { Telemetry } from "core/util/posthog";
import { v4 as uuidv4 } from "uuid";
import * as vscode from "vscode";
import { TabAutocompleteModel } from "../util/loadAutocompleteModel";
import { getDefinitionsFromLsp } from "./lsp";
import { setupStatusBar, stopStatusBarLoading } from "./statusBar";

export class ContinueCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private onError(e: any) {
    const options = ["Documentation"];
    if (e.message.includes("https://ollama.ai")) {
      options.push("Download Ollama");
    }
    vscode.window.showErrorMessage(e.message, ...options).then((val) => {
      if (val === "Documentation") {
        vscode.env.openExternal(
          vscode.Uri.parse(
            "https://docs.continue.dev/walkthroughs/tab-autocomplete",
          ),
        );
      } else if (val === "Download Ollama") {
        vscode.env.openExternal(vscode.Uri.parse("https://ollama.ai"));
      }
    });
  }

  private completionProvider: CompletionProvider;

  constructor(
    private readonly configHandler: ConfigHandler,
    private readonly ide: IDE,
    private readonly tabAutocompleteModel: TabAutocompleteModel,
  ) {
    this.completionProvider = new CompletionProvider(
      this.configHandler,
      this.ide,
      this.tabAutocompleteModel.get.bind(this.tabAutocompleteModel),
      this.onError.bind(this),
      getDefinitionsFromLsp,
    );
  }

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
    //@ts-ignore
  ): ProviderResult<InlineCompletionItem[] | InlineCompletionList> {
    const enableTabAutocomplete =
      vscode.workspace
        .getConfiguration("continue")
        .get<boolean>("enableTabAutocomplete") || false;
    if (token.isCancellationRequested || !enableTabAutocomplete) {
      return [];
    }

    try {
      const abortController = new AbortController();
      const signal = abortController.signal;
      token.onCancellationRequested(() => abortController.abort());

      const config = await this.configHandler.loadConfig();
      let clipboardText = "";
      if (config.tabAutocompleteOptions?.useCopyBuffer === true) {
        clipboardText = await vscode.env.clipboard.readText();
      }

      // Handle notebook cells
      const pos = {
        line: position.line,
        character: position.character,
      };
      let manuallyPassFileContents: string | undefined = undefined;
      if (document.uri.scheme === "vscode-notebook-cell") {
        const notebook = vscode.workspace.notebookDocuments.find((notebook) =>
          notebook
            .getCells()
            .some((cell) => cell.document.uri === document.uri),
        );
        if (notebook) {
          const cells = notebook.getCells();
          manuallyPassFileContents = cells
            .map((cell) => {
              const text = cell.document.getText();
              if (cell.kind === vscode.NotebookCellKind.Markup) {
                return `"""${text}"""`;
              } else {
                return text;
              }
            })
            .join("\n\n");
          for (const cell of cells) {
            if (cell.document.uri === document.uri) {
              break;
            } else {
              pos.line += cell.document.getText().split("\n").length + 1;
            }
          }
        }
      }
      // Handle commit message input box
      let manuallyPassPrefix: string | undefined = undefined;
      if (document.uri.scheme === "vscode-scm") {
        return [];
        // let diff = await this.ide.getDiff();
        // diff = diff.split("\n").splice(-150).join("\n");
        // manuallyPassPrefix = `${diff}\n\nCommit message: `;
      }

      const input: AutocompleteInput = {
        completionId: uuidv4(),
        filepath: document.uri.fsPath,
        pos,
        recentlyEditedFiles: [],
        recentlyEditedRanges: [],
        clipboardText: clipboardText,
        manuallyPassFileContents,
        manuallyPassPrefix,
      };

      setupStatusBar(true, true);
      const outcome =
        await this.completionProvider.provideInlineCompletionItems(
          input,
          signal,
        );

      if (!outcome || !outcome.completion) {
        return [];
      }

      const logRejectionTimeout = setTimeout(() => {
        // Wait 10 seconds, then assume it wasn't accepted
        outcome.accepted = false;
        logDevData("autocomplete", outcome);
        Telemetry.capture("autocomplete", {
          accepted: outcome.accepted,
          modelName: outcome.modelName,
          modelProvider: outcome.modelProvider,
          time: outcome.time,
          cacheHit: outcome.cacheHit,
        });
      }, 10_000);

      return [
        new vscode.InlineCompletionItem(
          outcome.completion,
          new vscode.Range(
            position,
            position.translate(0, outcome.completion.length),
          ),
          {
            title: "Log Autocomplete Outcome",
            command: "continue.logAutocompleteOutcome",
            arguments: [outcome, logRejectionTimeout],
          },
        ),
      ];
    } finally {
      stopStatusBarLoading();
    }
  }
}
