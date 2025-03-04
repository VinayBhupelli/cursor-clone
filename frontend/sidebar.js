// Get VS Code API
const vscode = acquireVsCodeApi();

// Available models
const AVAILABLE_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];

// Initialize state
let state = {
    messages: [],
    selectedModel: 'gemini-2.0-flash'  // Default to flash model
};

// Try to load previous state
const previousState = vscode.getState();
if (previousState) {
    // Ensure the loaded model is still valid
    state = {
        ...previousState,
        selectedModel: AVAILABLE_MODELS.includes(previousState.selectedModel) 
            ? previousState.selectedModel 
            : 'gemini-2.0-flash'
    };
}

document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-btn');
    const messagesContainer = document.getElementById('chat-messages');
    const modelSelector = document.getElementById('model-selector');

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
            // Reset to default if invalid model selected
            e.target.value = state.selectedModel;
        }
    });

    // Restore previous messages
    renderMessages();

    // Handle send button click
    sendButton.addEventListener('click', sendMessage);

    // Handle enter key
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Handle message from extension
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'response':
                removeTypingIndicator();
                addMessage('AI', message.text);
                break;
        }
    });
});

function sendMessage() {
    const chatInput = document.getElementById('chat-input');
    const text = chatInput.value.trim();
    
    if (text) {
        addMessage('User', text);
        showTypingIndicator();
        
        // Send message to extension with selected model
        vscode.postMessage({
            command: 'ask',
            text: text,
            model: state.selectedModel
        });
        
        chatInput.value = '';
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
    
    messageElement.appendChild(header);
    messageElement.appendChild(content);
    messagesContainer.appendChild(messageElement);
}

function formatMessage(text) {
    // Convert code blocks
    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code class="language-${lang || ''}">${escapeHtml(code.trim())}</code></pre>`;
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
