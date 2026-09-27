/** Voice input for the active conversation draft. */
type DictationResult = { isFinal: boolean; 0: { transcript: string } };
type DictationEvent = { resultIndex: number; results: ArrayLike<DictationResult> };
type DictationEngine = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: DictationEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
type DictationWindow = Window & {
  SpeechRecognition?: new () => DictationEngine;
  webkitSpeechRecognition?: new () => DictationEngine;
};
let dictationEngine: DictationEngine | undefined;
let dictationConversationId: string | undefined;
let dictationActive = false;
let dictationUsingHost = false;
let voiceHostAvailable = false;

const appendDictatedText = (conversationId: string, text: string): void => {
  if (activeId() !== conversationId || !text.trim()) return;
  const field = root.querySelector<HTMLTextAreaElement>("#composer-prompt");
  if (!field) return;
  field.value = `${field.value}${field.value && !/\s$/u.test(field.value) ? " " : ""}${text.trim()}`.slice(0, BACHATA_TEXT_LIMITS.preparedDraftUnits);
  field.dispatchEvent(new Event("input", { bubbles: true }));
};
const toggleDictation = (): void => {
  if (dictationUsingHost) {
    vscode.postMessage({ type: "voice.stop" });
    return;
  }
  if (dictationEngine) {
    dictationEngine.stop();
    return;
  }
  if (voiceHostAvailable) {
    dictationConversationId = activeId();
    dictationUsingHost = true;
    dictationActive = true;
    vscode.postMessage({ type: "voice.start", conversationId: dictationConversationId });
    announceStatus(localize("Starting voice input…"));
    scheduleRender();
    return;
  }
  const provider = window as DictationWindow;
  const Constructor = provider.SpeechRecognition ?? provider.webkitSpeechRecognition;
  if (!Constructor) {
    announceStatus(localize("Voice input is unavailable in this VS Code webview."));
    return;
  }
  const engine = new Constructor();
  const conversationId = activeId();
  engine.lang = navigator.language || "en-US";
  engine.continuous = true;
  engine.interimResults = false;
  engine.onresult = (event) => {
    if (activeId() !== conversationId) {
      engine.stop();
      return;
    }
    const text = Array.from(event.results).slice(event.resultIndex)
      .filter((result) => result.isFinal)
      .map((result) => result[0].transcript.trim())
      .filter(Boolean).join(" ");
    if (!text) return;
    appendDictatedText(conversationId, text);
  };
  engine.onerror = (event) => {
    if (event.error !== "no-speech" && event.error !== "aborted") {
      announceStatus(localize("Voice input stopped: {0}", event.error));
    }
  };
  engine.onend = () => {
    if (dictationEngine !== engine) return;
    dictationEngine = undefined;
    dictationConversationId = undefined;
    dictationActive = false;
    scheduleRender();
  };
  try {
    engine.start();
    dictationEngine = engine;
    dictationConversationId = conversationId;
    dictationActive = true;
    announceStatus(localize("Listening. Speak to add text to the message."));
    scheduleRender();
  } catch (error) {
    announceStatus(localize("Could not start voice input: {0}", error instanceof Error ? error.message : String(error)));
  }
};
