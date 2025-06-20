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
        console.log('=== AAC拡張機能の初期化開始 ===');
        
        try {
            // Git拡張機能を取得
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension) {
                console.log('Git拡張機能が見つかりました');
                this.gitExtension = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
                console.log('Git拡張機能の状態:', gitExtension.isActive ? 'アクティブ' : 'アクティベート済み');
                
                // Git API の確認
                if (this.gitExtension?.getAPI) {
                    const git = this.gitExtension.getAPI(1);
                    console.log('Git API バージョン 1 を取得しました');
                    console.log('利用可能なメソッド:', Object.getOwnPropertyNames(git));
                    this.setupGitWatcher();
                } else {
                    console.error('Git API が利用できません');
                    vscode.window.showErrorMessage('Git API が利用できません。VSCodeを再起動してください。');
                }
            } else {
                console.error('Git拡張機能が見つかりません');
                vscode.window.showErrorMessage('Git拡張機能が見つかりません。');
            }

            // 初回起動時のAPIキー確認
            await this.checkApiKeySetup();
            
            // ステータスバーの初期表示を更新
            await this.updateStatusBarDefault();
            
            console.log('=== AAC拡張機能の初期化完了 ===');
        } catch (error) {
            console.error('AAC拡張機能の初期化でエラーが発生:', error);
            vscode.window.showErrorMessage(`AAC初期化エラー: ${error instanceof Error ? error.message : error}`);
        }
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
            console.error('Git API が取得できません');
            return;
        }

        const git = this.gitExtension.getAPI(1);
        console.log('Git API オブジェクト:', git);
        console.log('Git API メソッド:', Object.getOwnPropertyNames(git));
        
        // リポジトリの変更を監視
        if (git.onDidOpenRepository) {
            git.onDidOpenRepository(() => {
                console.log('新しいリポジトリが開かれました');
                this.watchAllRepositories(git);
            });
        }
        
        if (git.onDidCloseRepository) {
            git.onDidCloseRepository(() => {
                console.log('リポジトリが閉じられました');
                this.watchAllRepositories(git);
            });
        }

        // 既存のリポジトリを監視
        this.watchAllRepositories(git);
    }

    private watchAllRepositories(git: any) {
        console.log('=== リポジトリ監視を開始 ===');
        console.log('リポジトリ数:', git.repositories?.length || 0);
        
        if (!git.repositories || git.repositories.length === 0) {
            console.warn('監視するリポジトリが見つかりません');
            vscode.window.showWarningMessage('AAC: Gitリポジトリが見つかりません。ワークスペースにGitリポジトリがあることを確認してください。');
            return;
        }
        
        git.repositories.forEach((repo: any, index: number) => {
            console.log(`リポジトリ ${index + 1}:`, repo.rootUri?.fsPath);
            console.log(`リポジトリ ${index + 1} の状態:`, repo.state);
            
            // ステージングエリアの変更を監視
            const disposable = repo.state.onDidChange(() => {
                console.log(`リポジトリ ${index + 1} の状態が変更されました`);
                this.handleRepositoryChange(repo);
            });
            
            // disposableをcontext.subscriptionsに追加
            this.context.subscriptions.push(disposable);
        });
    }

    private async handleRepositoryChange(repo: any) {
        console.log('=== リポジトリ変更を検知 ===');
        console.log('処理中フラグ:', this.isProcessing);
        console.log('リポジトリパス:', repo.rootUri?.fsPath);
        console.log('リポジトリ状態:', repo.state);
        console.log('インデックス変更:', repo.state.indexChanges);
        console.log('作業ディレクトリ変更:', repo.state.workingTreeChanges);
        
        if (this.isProcessing) {
            console.log('既に処理中のため、スキップします');
            return;
        }

        // ステージングされたファイルがあるかチェック
        const stagedChanges = repo.state.indexChanges;
        console.log('ステージングされたファイル数:', stagedChanges.length);
        
        if (stagedChanges.length > 0) {
            console.log('ステージングされた変更を検知しました');
            console.log('ステージングされたファイル:', stagedChanges.map((change: any) => change.uri.fsPath));
            
            // ステータスバーの表示を更新
            this.updateStatusBar('$(sync~spin) AAC: 検知済み', 'ステージングされた変更を検知');
            
            await this.generateCommitMessage(repo);
        } else {
            console.log('ステージングされた変更はありません');
        }
    }

    private async generateCommitMessage(repo: any) {
        console.log('=== コミットメッセージ生成開始 ===');
        
        this.isProcessing = true;
        this.updateStatusBar('$(sync~spin) AAC: 処理中...', 'コミットメッセージを生成中');

        try {
            const config = await this.getConfig();
            
            console.log('設定:', {
                hasApiKey: !!config.geminiApiKey,
                autoCommitEnabled: config.autoCommitEnabled,
                customPrompt: config.customPrompt.substring(0, 100) + '...'
            });
            
            if (!config.geminiApiKey) {
                throw new Error('Gemini APIキーが設定されていません。設定画面で設定してください。');
            }

            // git diff --staged を実行して差分を取得
            console.log('ステージングされた差分を取得中...');
            const diff = await this.getStagedDiff(repo.rootUri.fsPath);
            
            console.log('取得した差分の文字数:', diff.length);
            console.log('差分プレビュー:', diff.substring(0, 200) + '...');
            
            if (!diff.trim()) {
                throw new Error('ステージングされた変更が見つかりません。');
            }

            // Gemini APIでコミットメッセージを生成
            console.log('Gemini APIを呼び出し中...');
            const commitMessage = await this.callGeminiAPI(config, diff);
            
            console.log('生成されたコミットメッセージ:', commitMessage);
            
            // 自動コミットが有効な場合はコミット実行
            if (config.autoCommitEnabled) {
                console.log('自動コミットを実行中...');
                await this.performCommit(repo, commitMessage);
                vscode.window.showInformationMessage(`自動コミットが完了しました: ${commitMessage}`);
            } else {
                console.log('手動確認モード');
                // 手動確認
                const action = await vscode.window.showInformationMessage(
                    `生成されたコミットメッセージ: ${commitMessage}`,
                    'コミットする',
                    'キャンセル'
                );
                
                if (action === 'コミットする') {
                    console.log('ユーザーがコミットを承認');
                    await this.performCommit(repo, commitMessage);
                    vscode.window.showInformationMessage('コミットが完了しました。');
                } else {
                    console.log('ユーザーがコミットをキャンセル');
                }
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '不明なエラーが発生しました';
            console.error('AAC Error:', error);
            vscode.window.showErrorMessage(`AAC エラー: ${errorMessage}`);
        } finally {
            console.log('=== コミットメッセージ生成終了 ===');
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
    
    // 強制的に通知を表示してデバッグ
    vscode.window.showInformationMessage('AAC拡張機能が起動しました！');

    const aacExtension = new AACExtension(context);
    
    // 初期化を非同期で実行
    aacExtension.initialize().then(() => {
        console.log('AAC初期化が完了しました');
        vscode.window.showInformationMessage('AAC初期化が完了しました');
    }).catch((error) => {
        console.error('AAC初期化でエラー:', error);
        vscode.window.showErrorMessage(`AAC初期化エラー: ${error}`);
    });

    // コマンドの登録
    const toggleCommand = vscode.commands.registerCommand('aac.toggleAutoCommit', () => {
        console.log('toggleAutoCommit コマンドが実行されました');
        aacExtension.toggleAutoCommit();
    });

    const setApiKeyCommand = vscode.commands.registerCommand('aac.setApiKey', () => {
        console.log('setApiKey コマンドが実行されました');
        aacExtension.setApiKey();
    });

    const setCustomPromptCommand = vscode.commands.registerCommand('aac.setCustomPrompt', () => {
        console.log('setCustomPrompt コマンドが実行されました');
        aacExtension.setCustomPrompt();
    });

    const showSettingsMenuCommand = vscode.commands.registerCommand('aac.showSettingsMenu', () => {
        console.log('showSettingsMenu コマンドが実行されました');
        aacExtension.showSettingsMenu();
    });

    context.subscriptions.push(toggleCommand, setApiKeyCommand, setCustomPromptCommand, showSettingsMenuCommand);
    
    console.log('=== AAC activate関数が完了しました ===');
}

export function deactivate() {
    console.log('AAC (AutoAiCommit) が停止しました');
}
