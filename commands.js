import { ApplicationCommandOptionType } from 'discord.js';

const commands = [
  {
    name: "settings",
    description: "Opens the User and Server settings menu.",
  },
  {
    name: "imagine",
    description: "Generates an image based on a text prompt.",
    options: [
      {
        name: "prompt",
        description: "The description for
