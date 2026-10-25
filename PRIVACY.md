# Privacy

Fediverse Wrapped only reads what is already public.

- **What it reads:** the public posts of the account that mentioned it, from
  the last 365 days. Never followers only posts, never direct messages.
- **What it stores:**
  - Your posts: never. They are counted in memory and then discarded.
  - The job queue: your account address, kept for up to 30 days.
  - The once a day list: a salted hash of your account, kept for 60 days.
  - The images: kept under an unguessable URL for 180 days, then deleted.
- **Visibility:** the reply is exactly as public as your mention.

Run by 54 Grad Software GmbH, https://www.54gradsoftware.de/
