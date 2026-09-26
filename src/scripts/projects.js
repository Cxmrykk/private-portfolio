/* ============================================================
   PROJECTS — dynamic loading from JSON/API endpoint
   Fetches project metadata and injects them into the DOM as 
   glass cards. The ocean/glass WebGL pipeline automatically 
   picks them up on the next render frame.
   ============================================================ */

export async function initProjects() {
  const container = document.getElementById('projects-container');
  if (!container) return;

  // URL to fetch data from. Currently points to the local JSON file.
  // When ready, simply swap this out for your API Gateway/GitHub endpoint.
  const endpoint = './projects.json';

  try {
    const response = await fetch(endpoint);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch projects: ${response.status}`);
    }
    
    const projects = await response.json();
    
    // Clear the loading state
    container.innerHTML = '';
    
    // Construct and inject each project card
    projects.forEach(proj => {
      // Changed to an anchor tag to act as a hyperlink
      const article = document.createElement('a');
      article.className = 'card glass';
      article.href = proj.link || '#';
      article.target = '_blank';
      article.rel = 'noopener noreferrer';
      
      const h3 = document.createElement('h3');
      h3.textContent = proj.title;
      
      const p = document.createElement('p');
      p.textContent = proj.description;
      
      const chipsDiv = document.createElement('div');
      chipsDiv.className = 'chips';
      
      proj.tags.forEach(tag => {
        const b = document.createElement('b');
        b.textContent = tag;
        chipsDiv.appendChild(b);
      });
      
      article.appendChild(h3);
      article.appendChild(p);
      article.appendChild(chipsDiv);
      
      container.appendChild(article);
    });

  } catch (error) {
    console.error('Error rendering projects:', error);
    // Graceful fallback for the UI
    container.innerHTML = `<p class="lede" style="grid-column: 1 / -1;">
      Unable to load projects from source at this time. Please try again later.
    </p>`;
  }
}
