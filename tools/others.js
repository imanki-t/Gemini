// others.js

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryOperation(fn, maxRetries, delayMs = 1000) {
  let error;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Attempt the operation
      return await fn();
    } catch (err) {
      console.log(`Attempt ${attempt + 1} failed: ${err.message}`);
      error = err;
      if (attempt < maxRetries) {
        console.log(`Waiting ${delayMs}ms before next attempt...`);
        // Wait before retrying
        await delay(delayMs);
        // Increase delay for subsequent attempts (simple exponential backoff)
        delayMs *= 2;
      } else {
        console.log(`All ${maxRetries} attempts failed.`);
      }
    }
  }

  // If all attempts fail, throw the last error
  throw new Error(`Operation failed after ${maxRetries + 1} attempts: ${error.message}`);
}

export {
  delay,
  retryOperation
};
