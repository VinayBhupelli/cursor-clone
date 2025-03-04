// Get VS Code API
const vscode = acquireVsCodeApi();

// Available models
const AVAILABLE_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];

// Initialize state
let state = {
    messages: [],
    selectedModel: 'gemini-2.0-flash',  // Default to flash model
    fileSuggestions: [],
    showingSuggestions: false
};

// Try to load previous state
const previousState = vscode.getState();
if (previousState) {
    state = {
        ...previousState,
        selectedModel: AVAILABLE_MODELS.includes(previousState.selectedModel) 
            ? previousState.selectedModel 
            : 'gemini-2.0-flash',
        showingSuggestions: false
    };
}

document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-btn');
    const messagesContainer = document.getElementById('chat-messages');
    const modelSelector = document.getElementById('model-selector');
    const fileSuggestionsContainer = document.getElementById('file-suggestions');

    // Set initial model selection
    if (state.selectedModel) {
        modelSelector.value = state.selectedModel;
    }

    // Handle model selection change
    modelSelector.addEventListener('change', (e) => {
        if (AVAILABLE_MODELS.includes(e.target.value)) {
            state.selectedModel = e.target.value;
            vscode.setState(state);
        } else {
            e.target.value = state.selectedModel;
        }
    });

    // Handle input changes for @ mentions and commands
    chatInput.addEventListener('input', (e) => {
        const text = e.target.value;
        const cursorPosition = e.target.selectionStart;
        const textBeforeCursor = text.substring(0, cursorPosition);
        
        // Handle @ mentions
        if (textBeforeCursor.includes('@')) {
            const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
            const query = textBeforeCursor.substring(lastAtSymbol + 1);
            
            if (query) {
                // Request file suggestions from extension
                vscode.postMessage({
                    command: 'getFileSuggestions',
                    query: query
                });
            }
        } else {
            hideSuggestions();
        }

        // Auto-resize textarea
        chatInput.style.height = 'auto';
        chatInput.style.height = chatInput.scrollHeight + 'px';
    });

    // Handle key commands
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        } else if (e.key === 'Enter' && e.shiftKey) {
            // Allow multiline input with Shift+Enter
            return;
        } else if (e.key === 'Tab' && state.showingSuggestions) {
            e.preventDefault();
            // Handle file suggestion completion
            const selected = fileSuggestionsContainer.querySelector('.selected');
            if (selected) {
                insertFileSuggestion(selected.textContent);
            }
        }
    });

    // Restore previous messages
    renderMessages();

    // Handle send button click
    sendButton.addEventListener('click', sendMessage);

    // Handle message from extension
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'response':
                removeTypingIndicator();
                addMessage('AI', message.text);
                break;
            case 'fileSuggestions':
                showFileSuggestions(message.suggestions);
                break;
        }
    });
});

function showFileSuggestions(suggestions) {
    const container = document.getElementById('file-suggestions');
    container.innerHTML = '';
    
    suggestions.forEach(suggestion => {
        const div = document.createElement('div');
        div.className = 'file-suggestion';
        div.textContent = suggestion;
        div.onclick = () => insertFileSuggestion(suggestion);
        container.appendChild(div);
    });
    
    container.style.display = suggestions.length ? 'block' : 'none';
    state.showingSuggestions = suggestions.length > 0;
}

function hideSuggestions() {
    const container = document.getElementById('file-suggestions');
    container.style.display = 'none';
    state.showingSuggestions = false;
}

function insertFileSuggestion(suggestion) {
    const chatInput = document.getElementById('chat-input');
    const text = chatInput.value;
    const cursorPosition = chatInput.selectionStart;
    const lastAtSymbol = text.lastIndexOf('@', cursorPosition);
    
    const newText = text.substring(0, lastAtSymbol) + '@' + suggestion + text.substring(cursorPosition);
    chatInput.value = newText;
    hideSuggestions();
}

function sendMessage() {
    const chatInput = document.getElementById('chat-input');
    const text = chatInput.value.trim();
    
    if (text) {
        addMessage('User', text);
        showTypingIndicator();
        
        vscode.postMessage({
            command: 'ask',
            text: text,
            model: state.selectedModel
        });
        
        chatInput.value = '';
        chatInput.style.height = 'auto';
        hideSuggestions();
    }
}

function addMessage(sender, text) {
    const message = {
        sender,
        text,
        timestamp: new Date().toISOString()
    };
    
    state.messages.push(message);
    vscode.setState(state);
    renderMessage(message);
    scrollToBottom();
}

function renderMessages() {
    const messagesContainer = document.getElementById('chat-messages');
    messagesContainer.innerHTML = '';
    state.messages.forEach(renderMessage);
    scrollToBottom();
}

function renderMessage(message) {
    const messagesContainer = document.getElementById('chat-messages');
    const messageElement = document.createElement('div');
    messageElement.className = `message ${message.sender.toLowerCase()}`;
    
    const header = document.createElement('div');
    header.className = 'message-header';
    header.textContent = `${message.sender} • ${formatTime(message.timestamp)}`;
    
    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = formatMessage(message.text);
    
    // Add apply buttons to code blocks
    content.querySelectorAll('.code-block').forEach(block => {
        const actions = document.createElement('div');
        actions.className = 'actions';
        
        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.onclick = () => {
            const code = block.querySelector('code').textContent;
            vscode.postMessage({
                command: 'applyCode',
                code: code,
                file: block.dataset.file
            });
        };
        
        actions.appendChild(applyBtn);
        block.appendChild(actions);
    });
    
    messageElement.appendChild(header);
    messageElement.appendChild(content);
    messagesContainer.appendChild(messageElement);
}

function formatMessage(text) {
    // Convert code blocks with file information
    text = text.replace(/```(\w+)?\s*(?:\{file:\s*([^}]+)\})?\n([\s\S]*?)```/g, (_, lang, file, code) => {
        const fileAttr = file ? `data-file="${escapeHtml(file)}"` : '';
        return `<div class="code-block" ${fileAttr}><pre><code class="language-${lang || ''}">${escapeHtml(code.trim())}</code></pre></div>`;
    });
    
    // Convert inline code
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Convert URLs to links
    text = text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
    
    // Convert line breaks
    text = text.replace(/\n/g, '<br>');
    
    return text;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom() {
    const messagesContainer = document.getElementById('chat-messages');
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function showTypingIndicator() {
    const messagesContainer = document.getElementById('chat-messages');
    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.id = 'typing-indicator';
    
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('div');
        dot.className = 'typing-dot';
        indicator.appendChild(dot);
    }
    
    messagesContainer.appendChild(indicator);
    scrollToBottom();
}

function removeTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) {
        indicator.remove();
    }
}
