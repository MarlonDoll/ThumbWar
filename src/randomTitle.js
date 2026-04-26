const { PERSONAS } = require('./personas');
const { FORMATS } = require('./formats');

// Fillers used to fill in [X] and [Y] blanks in YouTube title formats.
// Chosen to be funny/relatable across many formats.
const X_FILLERS = [
  'My Dog', 'My Mom', 'My Boss', 'A Stranger', 'My Therapist',
  'A Toddler', 'A Goose', 'A Pizza', 'AI', 'Crypto',
  'Costco', 'IKEA', 'Disneyland', 'My Dentist', 'My Ex',
  'A Roomba', 'A Dragon', 'The DMV', 'TikTok', 'A Vampire',
  'Money', 'Coffee', 'Cheese', 'Bubble Wrap', 'A Banana',
  'My Wi-Fi', 'A Lawyer', 'A Time Traveler', 'My Landlord', 'Spaghetti'
];

const Y_FILLERS = [
  '24 Hours', '7 Days', '30 Days', '$10,000', '$1',
  'a Week', 'a Year', 'a Plane', 'an Island', 'My House',
  '100 People', 'a Pirate Ship', 'a Volcano', 'Walmart', 'Antarctica',
  'a Submarine', 'a Karen', 'a Cult', 'an Audit', 'a Roller Coaster'
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Build a fully filled-in random title (no placeholders).
function generateRandomTitle() {
  const persona = pick(PERSONAS);
  let title = pick(FORMATS);
  // Replace any [X], [Y], [Z], [Location], etc with random fillers
  title = title.replace(/\[X\]/g, () => pick(X_FILLERS));
  title = title.replace(/\[Y\]/g, () => pick(Y_FILLERS));
  title = title.replace(/\[[^\]]+\]/g, () => pick(X_FILLERS));
  return { persona, title };
}

module.exports = { generateRandomTitle };
