import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";
import moment from "moment-timezone"; // Import Moment.js
import express from "express";
import bodyParser from "body-parser";

// Load environment variables
dotenv.config();

// Access the token and MongoDB URI from .env
const token = process.env.MYBOT_API;
const mongoUrl = process.env.MONGODB_URI;
const port = process.env.PORT || 3000; // Set port from environment variable or default to 3000
const webhookUrl = process.env.WEBHOOK_URL; // Ensure this URL is correctly set

// Initialize the bot without polling
const bot = new TelegramBot(token);

// Initialize MongoDB client
const client = new MongoClient(mongoUrl);

// Set up Express
const app = express();
app.use(bodyParser.json());

// Webhook route
app.post(`/webhook/${token}`, async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error("Error processing webhook update:", error);
    res.sendStatus(500);
  }
});

(async () => {
  try {
    // Connect to MongoDB
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db("telegram_bot"); // Database name
    const tasksCollection = db.collection("tasks"); // Tasks collection
    const remindersCollection = db.collection("reminders"); // Reminders collection

    // Set up webhook
    await bot.setWebHook(`${webhookUrl}/webhook/${token}`);
    console.log(`Webhook set up at ${webhookUrl}/webhook/${token}`);

    // Start the Express server
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });

    // Add your existing commands and logic here...

    // Start command
    bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const firstName = msg.from.first_name || "there"; // Get the user's first name or default to 'there'

      // Define the list of commands
      const commands = `
Here are the commands you can use with the Daily Activities Manager Bot:

1. /start - Welcome message and instructions on how to use the bot.
2. /addtask [task] - Add a new task to your list. Example: /addtask Buy groceries
3. /listtasks - List all your tasks.
4. /remind [reminder text] at [time] - Set a new reminder. Example: /remind Meeting with team at 3:00 PM
5. /listreminders - List all your reminders.
6. /deletetask [task number] - Delete a specific task from your list. Example: /deletetask 2
7. /deletealltasks - Delete all tasks from your list.

Feel free to use these commands to manage your tasks and reminders. If you have any questions or need help, just ask!`;

      // Send the personalized welcome message
      await bot.sendMessage(
        chatId,
        `Hello ${firstName}! Welcome to your Daily Activities Manager Bot! Here are the available commands:\n${commands}`
      );
    });

    // Add task command
    bot.onText(/\/addtask (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const task = match[1];

      // Store task in MongoDB
      await tasksCollection.updateOne(
        { chatId: chatId }, // Find by chatId
        { $push: { tasks: task } }, // Push task to 'tasks' array
        { upsert: true } // Create new entry if none exists
      );

      await bot.sendMessage(chatId, `Task added: ${task}`);
    });

    // List tasks command
    bot.onText(/\/listtasks/, async (msg) => {
      const chatId = msg.chat.id;

      // Fetch tasks from MongoDB
      const userTasks = await tasksCollection.findOne({ chatId: chatId });

      if (!userTasks || userTasks.tasks.length === 0) {
        await bot.sendMessage(chatId, "You have no tasks.");
      } else {
        const taskList = userTasks.tasks
          .map((task, index) => `${index + 1}. ${task}`)
          .join("\n");
        await bot.sendMessage(chatId, `Here are your tasks:\n${taskList}`);
      }
    });

    // Delete task command
    bot.onText(/\/deletetask (\d+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const taskIndex = parseInt(match[1]) - 1;

      // Fetch user tasks
      const userTasks = await tasksCollection.findOne({ chatId: chatId });

      if (userTasks && userTasks.tasks[taskIndex]) {
        const deletedTask = userTasks.tasks[taskIndex];

        // Remove task from array
        userTasks.tasks.splice(taskIndex, 1);

        // Update MongoDB
        await tasksCollection.updateOne(
          { chatId: chatId },
          { $set: { tasks: userTasks.tasks } }
        );

        await bot.sendMessage(chatId, `Task deleted: ${deletedTask}`);
      } else {
        await bot.sendMessage(chatId, "Invalid task number.");
      }
    });

    // Set reminder command
    bot.onText(/\/remind (.+) at (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const reminderText = match[1];
      const timeStr = match[2];

      // Parse and format reminder time
      const reminderTime = moment
        .tz(timeStr, "hh:mm A", "Asia/Kolkata")
        .toISOString();

      const reminder = {
        text: reminderText,
        time: reminderTime,
      };

      // Store reminder in MongoDB
      await remindersCollection.updateOne(
        { chatId: chatId }, // Find by chatId
        { $push: { reminders: reminder } }, // Push reminder to 'reminders' array
        { upsert: true } // Create new entry if none exists
      );

      await bot.sendMessage(
        chatId,
        `Reminder set: ${reminderText} at ${timeStr}`
      );
    });

    // List reminders command
    bot.onText(/\/listreminders/, async (msg) => {
      const chatId = msg.chat.id;

      // Fetch reminders from MongoDB
      const userReminders = await remindersCollection.findOne({
        chatId: chatId,
      });

      if (!userReminders || userReminders.reminders.length === 0) {
        await bot.sendMessage(chatId, "You have no reminders.");
      } else {
        const reminderList = userReminders.reminders
          .map(
            (reminder) =>
              `${moment(reminder.time).format("hh:mm A")}: ${reminder.text}`
          )
          .join("\n");
        await bot.sendMessage(
          chatId,
          `Here are your reminders:\n${reminderList}`
        );
      }
    });

    // Periodically send reminders and remove only finished ones
    setInterval(async () => {
      const now = moment().tz("Asia/Kolkata");

      const reminderUsers = await remindersCollection.find().toArray();

      for (const user of reminderUsers) {
        const remainingReminders = [];

        for (const reminder of user.reminders) {
          const reminderTime = moment(reminder.time);

          if (now.isSameOrAfter(reminderTime, "minute")) {
            await bot.sendMessage(user.chatId, `Reminder: ${reminder.text}`);
          } else {
            // Keep future reminders
            remainingReminders.push(reminder);
          }
        }

        // Update user's reminders with only future ones
        await remindersCollection.updateOne(
          { chatId: user.chatId },
          { $set: { reminders: remainingReminders } }
        );
      }
    }, 60000); // Check every minute
  } catch (err) {
    console.error("Error connecting to MongoDB:", err);
  }
})();

// Handle unknown commands
bot.onText(/\/(.*)/, async (msg) => {
  const chatId = msg.chat.id;
  const command = msg.text.split(" ")[0]; // Extract command part

  const validCommands = [
    "/start",
    "/addtask",
    "/listtasks",
    "/deletetask",
    "/deletealltasks",
    "/remind",
    "/listreminders",
  ];

  if (!validCommands.includes(command)) {
    await bot.sendMessage(chatId, "Sorry, I didn't understand that command.");
  }
});
