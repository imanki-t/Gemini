import { ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType } from 'discord.js';

export async function addDownloadButton(botMessage) {
  try {
    const messageComponents = botMessage.components || [];
    const downloadButton = new ButtonBuilder()
      .setCustomId('download_message')
      .setLabel('Save')
      .setEmoji('💾')
      .setStyle(ButtonStyle.Secondary);

    let actionRow;
    if (messageComponents.length > 0 && messageComponents[0].type === ComponentType.ActionRow) {
      actionRow = ActionRowBuilder.from(messageComponents[0]);
    } else {
      actionRow = new ActionRowBuilder();
    }

    actionRow.addComponents(downloadButton);
    return await botMessage.edit({
      components: [actionRow]
    });
  } catch (error) {
    console.error('Error adding download button:', error.message);
    return botMessage;
  }
}

export async function addDeleteButton(botMessage, msgId) {
  try {
    const messageComponents = botMessage.components || [];
    const deleteButton = new ButtonBuilder()
      .setCustomId(`delete_message-${msgId}`)
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger);

    let actionRow;
    if (messageComponents.length > 0 && messageComponents[0].type === ComponentType.ActionRow && messageComponents[0].components.length < 5) {
      actionRow = ActionRowBuilder.from(messageComponents[0]);
    } else {
      actionRow = new ActionRowBuilder();
      if (messageComponents.length > 0) {
        const existingComponents = messageComponents[0].components.map(c => ButtonBuilder.from(c));
        actionRow.addComponents(existingComponents);
      }
    }

    if (actionRow.components.length < 5) {
      actionRow.addComponents(deleteButton);
    } else {
      const newRow = new ActionRowBuilder().addComponents(deleteButton);
      return await botMessage.edit({
        components: [actionRow, newRow]
      });
    }

    return await botMessage.edit({
      components: [actionRow]
    });
  } catch (error) {
    console.error('Error adding delete button:', error.message);
    return botMessage;
  }
}
