import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface AACConfig {
    geminiApiKey: string;
    autoCommitEnabled: boolean;
    customPrompt: string;
}

class AACExtension {
    private statusBarItem: vscode.StatusBarItem;
    private gitExtension: any;
    private isProcessing: boolean = false;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.text = '$(git-commit) AAC';
        this.statusBarItem.tooltip = 'AutoAiCommit - Ready (クリックで設定メニュー)';
        this.statusBarItem.command = 'aac.showSettingsMenu';
        this.statusBarItem.show();
        this.context.subscriptions.push(this.statusBarItem);
    }

    async initialize() {
        // Git拡張機能を取得
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (gitExtension) {
            this.gitExtension = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
            this.setupGitWatcher();
        } else {
            vscode.window.showErrorMessage('Git拡張機能が見つかりません。');
        }

        // 初回起動時のAPIキー確認
        await this.checkApiKeySetup();
        
        // ステータスバーの初期表示を更新
        await this.updateStatusBarDefault();
    }

    private async checkApiKeySetup() {
        const apiKey = await this.context.secrets.get('aac.geminiApiKey');
        if (!apiKey) {
            const result = await vscode.window.showInformationMessage(
                'AAC拡張機能を使用するにはGemini APIキーの設定が必要です。',
                'APIキーを設定',
                '後で設定'
            );
            
            if (result === 'APIキーを設定') {
                await this.setApiKey();
            }
        }
    }

    private setupGitWatcher() {
        if (!this.gitExtension?.getAPI) {
            return;
        }

        const git = this.gitExtension.getAPI(1);
        
        // リポジトリの変更を監視
        git.onDidChangeRepositories(() => {
            this.watchAllRepositories(git);
        });

        // 既存のリポジトリを監視
        this.watchAllRepositories(git);
    }

    private watchAllRepositories(git: any) {
        git.repositories.forEach((repo: any) => {
            // ステージングエリアの変更を監視
            repo.state.onDidChange(() => {
                this.handleRepositoryChange(repo);
            });
        });
    }

    private async handleRepositoryChange(repo: any) {
        if (this.isProcessing) {
            return;
        }

        // ステージングされたファイルがあるかチェック
        const stagedChanges = repo.state.indexChanges;
        if (stagedChanges.length > 0) {
            console.log('ステージングされた変更を検知しました');
            await this.generateCommitMessage(repo);
        }
    }

    private async generateCommitMessage(repo: any) {
        this.isProcessing = true;
        this.updateStatusBar('$(sync~spin) AAC: 処理中...', 'コミットメッセージを生成中');

        try {
            const config = await this.getConfig();
            
            if (!config.geminiApiKey) {
                throw new Error('Gemini APIキーが設定されていません。設定画面で設定してください。');
            }

            // git diff --staged を実行して差分を取得
            const diff = await this.getStagedDiff(repo.rootUri.fsPath);
            
            if (!diff.trim()) {
                throw new Error('ステージングされた変更が見つかりません。');
            }

            // Gemini APIでコミットメッセージを生成
            const commitMessage = await this.callGeminiAPI(config, diff);
            
            // 自動コミットが有効な場合はコミット実行
            if (config.autoCommitEnabled) {
                await this.performCommit(repo, commitMessage);
                vscode.window.showInformationMessage(`自動コミットが完了しました: ${commitMessage}`);
            } else {
                // 手動確認
                const action = await vscode.window.showInformationMessage(
                    `生成されたコミットメッセージ: ${commitMessage}`,
                    'コミットする',
                    'キャンセル'
                );
                
                if (action === 'コミットする') {
                    await this.performCommit(repo, commitMessage);
                    vscode.window.showInformationMessage('コミットが完了しました。');
                }
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '不明なエラーが発生しました';
            vscode.window.showErrorMessage(`AAC エラー: ${errorMessage}`);
            console.error('AAC Error:', error);
        } finally {
            this.isProcessing = false;
            await this.updateStatusBarDefault();
        }
    }

    private async getStagedDiff(repoPath: string): Promise<string> {
        try {
            const { stdout } = await execAsync('git diff --staged', { cwd: repoPath });
            return stdout;
        } catch (error) {
            throw new Error('git diff --staged の実行に失敗しました');
        }
    }

    private async callGeminiAPI(config: AACConfig, diff: string): Promise<string> {
        try {
            const { GoogleGenAI } = await import('@google/genai');
            
            const ai = new GoogleGenAI({apiKey: config.geminiApiKey});

            const prompt = `${config.customPrompt}
													# 入力
													\`\`\`
													${diff}
													\`\`\``;

            const response = await ai.models.generateContent({
                model: 'gemini-2.0-flash-001',
                contents: prompt,
            });
            
            const text = response.text;
            if (!text) {
                throw new Error('Gemini APIからレスポンステキストを取得できませんでした');
            }
            
            return text.trim();
            
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('API_KEY_INVALID')) {
                    throw new Error('無効なGemini APIキーです。設定を確認してください。');
                } else if (error.message.includes('QUOTA_EXCEEDED')) {
                    throw new Error('Gemini APIの使用量制限に達しました。しばらく待ってから再試行してください。');
                }
            }
            throw new Error(`Gemini APIの呼び出しに失敗しました: ${error instanceof Error ? error.message : error}`);
        }
    }

    private async performCommit(repo: any, message: string) {
        try {
            await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { 
                cwd: repo.rootUri.fsPath 
            });
        } catch (error) {
            throw new Error('git commit の実行に失敗しました');
        }
    }

    private async getConfig(): Promise<AACConfig> {
        const config = vscode.workspace.getConfiguration('aac');
        
        // シークレットストレージからAPIキーを取得
        const apiKey = await this.context.secrets.get('aac.geminiApiKey') || '';
        
        return {
            geminiApiKey: apiKey,
            autoCommitEnabled: config.get<boolean>('autoCommitEnabled', false),
            customPrompt: config.get<string>('customPrompt', 
                `# 指示
git diffから、以下のルールで日本語のコミットメッセージを生成。

# ルール
- 役割: シニアエンジニア
- 件名: \`【種類】概要\` (50字以内)
- 空行: 件名と本文の間に必須
- 本文: 変更の背景や内容を箇条書きで記述。補足が必要な場合のみ。
- 種類: \`fix\`, \`add\`, \`update\`, \`change\`, \`clean\`, \`disable\`, \`remove\` から最も適切なものを選択。
- 例外: 回答はメッセージ本体のみ。他の説明は不要。`
            )
        };
    }

    private updateStatusBar(text?: string, tooltip?: string) {
        if (text && tooltip) {
            this.statusBarItem.text = text;
            this.statusBarItem.tooltip = tooltip;
        } else {
            // デフォルトの状態表示を更新
            this.updateStatusBarDefault();
        }
    }

    private async updateStatusBarDefault() {
        const config = vscode.workspace.getConfiguration('aac');
        const autoCommitEnabled = config.get<boolean>('autoCommitEnabled', false);
        const hasApiKey = !!(await this.context.secrets.get('aac.geminiApiKey'));
        
        const autoIcon = autoCommitEnabled ? '$(check)' : '$(x)';
        const apiIcon = hasApiKey ? '$(key)' : '$(warning)';
        
        this.statusBarItem.text = `$(git-commit) AAC ${autoIcon}${apiIcon}`;
        this.statusBarItem.tooltip = `AutoAiCommit - 自動コミット: ${autoCommitEnabled ? '有効' : '無効'}, APIキー: ${hasApiKey ? '設定済み' : '未設定'} (クリックで設定メニュー)`;
    }

    toggleAutoCommit() {
        const config = vscode.workspace.getConfiguration('aac');
        const currentValue = config.get<boolean>('autoCommitEnabled', false);
        config.update('autoCommitEnabled', !currentValue, vscode.ConfigurationTarget.Global);
        
        const newStatus = !currentValue ? '有効' : '無効';
        vscode.window.showInformationMessage(`自動コミットを${newStatus}にしました。`);
        
        // ステータスバーを更新
        this.updateStatusBarDefault();
    }

    async setApiKey() {
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Gemini APIキーを入力してください',
            placeHolder: 'Google AI Studioで取得したAPIキーを入力',
            password: true,
            ignoreFocusOut: true
        });

        if (apiKey && apiKey.trim()) {
            await this.context.secrets.store('aac.geminiApiKey', apiKey.trim());
            vscode.window.showInformationMessage('Gemini APIキーが保存されました。');
            
            // ステータスバーを更新
            await this.updateStatusBarDefault();
        }
    }

    async setCustomPrompt() {
        const config = vscode.workspace.getConfiguration('aac');
        const currentPrompt = config.get<string>('customPrompt', '');
        
        const newPrompt = await vscode.window.showInputBox({
            prompt: 'カスタムプロンプトを入力してください',
            placeHolder: 'Gemini APIに送信するプロンプトテンプレート',
            value: currentPrompt,
            ignoreFocusOut: true
        });

        if (newPrompt !== undefined) {
            await config.update('customPrompt', newPrompt, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('カスタムプロンプトが保存されました。');
        }
    }

    async showSettingsMenu() {
        const config = vscode.workspace.getConfiguration('aac');
        const autoCommitEnabled = config.get<boolean>('autoCommitEnabled', false);
        const hasApiKey = !!(await this.context.secrets.get('aac.geminiApiKey'));
        
        const autoCommitStatus = autoCommitEnabled ? '✅ 有効' : '❌ 無効';
        const apiKeyStatus = hasApiKey ? '✅ 設定済み' : '❌ 未設定';
        
        const menuItems = [
            {
                label: `$(gear) 自動コミット: ${autoCommitStatus}`,
                description: '自動コミットのON/OFFを切り替え',
                action: 'toggleAutoCommit'
            },
            {
                label: `$(key) APIキー: ${apiKeyStatus}`,
                description: 'Gemini APIキーを設定',
                action: 'setApiKey'
            },
            {
                label: '$(edit) カスタムプロンプト設定',
                description: 'プロンプトをカスタマイズ',
                action: 'setCustomPrompt'
            },
            {
                label: '$(settings-gear) VSCode設定を開く',
                description: 'AAC設定をVSCodeの設定画面で編集',
                action: 'openSettings'
            }
        ];

        const selectedItem = await vscode.window.showQuickPick(menuItems, {
            placeHolder: 'AAC (AutoAiCommit) 設定メニュー',
            title: 'AAC設定'
        });

        if (selectedItem) {
            switch (selectedItem.action) {
                case 'toggleAutoCommit':
                    this.toggleAutoCommit();
                    break;
                case 'setApiKey':
                    await this.setApiKey();
                    break;
                case 'setCustomPrompt':
                    await this.setCustomPrompt();
                    break;
                case 'openSettings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:aac');
                    break;
            }
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('AAC (AutoAiCommit) が起動しました');

    const aacExtension = new AACExtension(context);
    aacExtension.initialize();

    // コマンドの登録
    const toggleCommand = vscode.commands.registerCommand('aac.toggleAutoCommit', () => {
        aacExtension.toggleAutoCommit();
    });

    const setApiKeyCommand = vscode.commands.registerCommand('aac.setApiKey', () => {
        aacExtension.setApiKey();
    });

    const setCustomPromptCommand = vscode.commands.registerCommand('aac.setCustomPrompt', () => {
        aacExtension.setCustomPrompt();
    });

    const showSettingsMenuCommand = vscode.commands.registerCommand('aac.showSettingsMenu', () => {
        aacExtension.showSettingsMenu();
    });

    context.subscriptions.push(toggleCommand, setApiKeyCommand, setCustomPromptCommand, showSettingsMenuCommand);
}

export function deactivate() {
    console.log('AAC (AutoAiCommit) が停止しました');
}
