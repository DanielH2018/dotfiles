(function(){
  var q       = document.getElementById('q');
  var reset   = document.getElementById('reset');
  var count   = document.getElementById('count');
  var empty   = document.getElementById('empty');
  var facets  = Array.prototype.slice.call(document.querySelectorAll('.facet'));
  var items   = Array.prototype.slice.call(document.querySelectorAll('.tool'));
  var sections= Array.prototype.slice.call(document.querySelectorAll('section'));
  var TOTAL   = items.length;

  items.forEach(function(el){
    el._hay = el.textContent.toLowerCase();
    el._f = {};
    facets.forEach(function(f){
      var key = f.getAttribute('data-facet');
      var raw = el.getAttribute('data-' + key) || '';
      el._f[key] = raw.split(/\s+/).filter(Boolean);
    });
  });

  function activeOf(f){
    return Array.prototype.slice.call(f.querySelectorAll('.chip[aria-pressed="true"]'))
      .map(function(c){ return c.getAttribute('data-v'); });
  }

  function passes(el, text, skipKey){
    if (text && el._hay.indexOf(text) === -1) return false;
    for (var i = 0; i < facets.length; i++){
      var key = facets[i].getAttribute('data-facet');
      if (key === skipKey) continue;
      var on = activeOf(facets[i]);
      if (!on.length) continue;
      var vals = el._f[key], hit = false;
      for (var j = 0; j < on.length; j++){
        if (vals.indexOf(on[j]) !== -1){ hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  }

  function apply(){
    var text = q.value.trim().toLowerCase();
    var shown = 0;

    items.forEach(function(el){
      var ok = passes(el, text, null);
      el.classList.toggle('hidden', !ok);
      if (ok) shown++;
    });

    sections.forEach(function(s){
      var n = s.querySelectorAll('.tool').length;
      var vis = s.querySelectorAll('.tool:not(.hidden)').length;
      s.classList.toggle('hidden', n > 0 && vis === 0);
    });

    facets.forEach(function(f){
      var key = f.getAttribute('data-facet');
      Array.prototype.slice.call(f.querySelectorAll('.chip')).forEach(function(c){
        var v = c.getAttribute('data-v'), n = 0;
        items.forEach(function(el){
          if (el._f[key].indexOf(v) !== -1 && passes(el, text, key)) n++;
        });
        var k = c.querySelector('.k');
        if (!k){ k = document.createElement('span'); k.className = 'k'; c.appendChild(k); }
        k.textContent = n;
        c.classList.toggle('dead', n === 0 && c.getAttribute('aria-pressed') !== 'true');
      });
    });

    var anyFacet = facets.some(function(f){ return activeOf(f).length > 0; });
    var filtering = anyFacet || !!text;
    reset.disabled = !filtering;
    empty.classList.toggle('on', shown === 0);
    count.textContent = filtering
      ? 'Showing ' + shown + ' of ' + TOTAL + ' entries'
      : TOTAL + ' entries';
  }

  facets.forEach(function(f){
    f.addEventListener('click', function(e){
      var c = e.target.closest ? e.target.closest('.chip') : null;
      if (!c) return;
      c.setAttribute('aria-pressed', c.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      apply();
    });
  });
  q.addEventListener('input', apply);
  reset.addEventListener('click', function(){
    q.value = '';
    facets.forEach(function(f){
      Array.prototype.slice.call(f.querySelectorAll('.chip')).forEach(function(c){
        c.setAttribute('aria-pressed', 'false');
      });
    });
    apply();
    q.focus();
  });

  apply();
})();
