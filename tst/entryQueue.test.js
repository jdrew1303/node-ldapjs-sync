/**
 * Copyright 2012 Yunong Xiao, Inc. All rights reserved.
 */

var Replicator = require('../lib/replicator.js');
var add = require('../lib/add.js');
var bunyan = require('bunyan');
var inMemLdap = require('../lib/inMemLdap.js');
var remoteInMemLdap = require('./remoteLdap');
var ldap = require('ldapjs');
var tap = require('tap');
var test = require('tap').test;
var uuid = require('node-uuid');

///--- Globals

var SUFFIX = 'o=yunong';
var REMOTE_SUFFIX = 'o=yunong';
var REMOTE_PORT = 23364;
var TOTAL_ENTRIES = 5;
var REMOTE_URL = 'ldap://cn=root:secret@127.0.0.1:' + REMOTE_PORT + '/' +
                    SUFFIX + '??sub?(uid=*)';

var LOCAL_PORT = 23456;
var LOCAL_URL = 'ldap://cn=root:secret@localhost:' + LOCAL_PORT;

var REPL_SUFFIX = 'cn=repl, o=yunong';
var ALL_CHANGES_CTRL = new ldap.PersistentSearchControl({
  type: '2.16.840.1.113730.3.4.3',
  value: {
    changeTypes: 15,
    changesOnly: false,
    returnECs: true
  }
});

var log = new bunyan({
    name: 'crud-integ-test',
    stream: process.stdout,
    level: 'trace',
    src: true
});

var suffix = {
  objectClass: ['top', 'organization'],
  o: SUFFIX.split('=')[1],
  uid: uuid()
};

var localBackend;
var localClient = null;
var localLdap;

var remoteBackend;
var remoteClient;
var remoteLdap;

var REPL_CONTEXT_OPTIONS = {
  log: log,
  remoteUrl: REMOTE_URL,
  localUrl: LOCAL_URL,
  checkpointDn: SUFFIX,
  replSuffix: REPL_SUFFIX
};

///--- Tests

test('setup-local', function(t) {
  inMemLdap.startServer({suffix: SUFFIX, port: LOCAL_PORT}, function(server) {
    t.ok(server);
    localClient = ldap.createClient({
      url: LOCAL_URL,
      log: log
    });
    localClient.once('connect', function(id) {
      t.ok(id);
      t.ok(localClient);
      console.log('local client connected');
      localClient.bind('cn=root', 'secret', function(err, res) {
        if (err) {
          t.fail(err);
        }
        t.ok(res);
        t.end();
      });
    });
  });
});

test('setup-remote', function(t) {
  remoteInMemLdap.startServer({suffix: REMOTE_SUFFIX, port: REMOTE_PORT},
                        function(server) {
    t.ok(server);
    remoteLdap = server;
    t.end();
  });
});

test('setup-remote-client', function(t) {
  remoteClient = ldap.createClient({
    url: REMOTE_URL,
    log: log
  });

  remoteClient.once('connect', function(id) {
    t.ok(id);
    t.ok(remoteClient);
    console.log('remote client connected');
    t.end();
  });
});

test('setup-replcontext', function(t) {
  REPL_CONTEXT_OPTIONS.localClient = localClient;
  replicator = new Replicator(REPL_CONTEXT_OPTIONS);
  replicator.once('init', function(self) {
    t.ok(replicator);
    t.ok(replicator.checkpoint);
    t.ok(replicator.entryQueue);
    t.ok(replicator.localPool);
    t.ok(replicator.remotePool);
    t.ok(replicator.remoteUrl);
    t.ok(replicator.entryQueue);
    t.ok(replicator.replSuffix);
    entryQueue = replicator.entryQueue;
    // we are technically good to go here after the init event, however, the
    // changelog psearch is asynchronous, so we have to wait here a bit while
    // that finishes. 1.5 seconds ought to do it.
    setTimeout(function() { t.end(); }, 1500);
  });
});


test('push event', function(t) {
  var entry = {
    foo: 'bar',
    baz: 'car',
    object: {
      changetype: 'add'
    },
    handlers: []
  };

  var numEntries = 0;
  entryQueue.on('push', function(changelog, index, queue) {
    numEntries++;
    t.ok(changelog);
    t.ok(index);
    t.ok(queue);
    if (numEntries === 3) {
      t.end();
    }
  });

  entryQueue.push(entry);
  entry.object.changetype = 'delete';
  entryQueue.push(entry);
  entry.object.changetype = 'modify';
  entryQueue.push(entry);
});

test('push with handler chain', function(t) {
  var entry = {
    foo: 'bar',
    baz: 'car',
    object: {
      changetype: 'add'
    }
  };

  var invoked1;
  var invoked2;
  var invocations = 0;
  var entries = 0;
  var func1 = function(changelog, replicator, next) {
    if (!invoked2) {
      invoked1 = true;
    }
    t.ok(changelog);
    t.ok(replicator);
    t.ok(next);
    invocations++;
    next();
  };
  var func2 = function(changelog, replicator, next) {
    if (invoked1) {
      invoked2 = true;
    }
    t.ok(changelog);
    t.ok(replicator);
    t.ok(next);
    invoked1 = false;
    invoked2 = false;
    invocations++;
    next();
  };

  entry.handlers = [func1, func2];

  entryQueue.on('popped', function() {
    entries++;
    if (entries === 2) {
      t.equal(invocations, 4);
      t.end();
    }
  });

  entryQueue.push(entry);
  entryQueue.push(entry);
});

test('push real add changelog', function(t) {
  var changelog = {
    object: {
      dn: 'changenumber=1326414273440, cn=changelog',
      controls: [],
      targetdn: 'o=yunong',
      changetime: '2012-01-13T00:24:33Z',
      changenumber: '1326414273442',
      changetype: 'add',
      changes: {
        objectclass: ['organizationalUnit'],
        ou: ['users'],
        uid: uuid()
      },
      objectclass: 'changeLogEntry'
    }
  };

  entryQueue.on('popped', function() {
    localClient.search('o=yunong, ' + REPL_SUFFIX,
                                   {filter: '(uid=*)'},
                                   function(err, res) {
      t.ok(res);
      res.on('searchEntry', function(entry) {
        t.ok(entry);
        t.ok(entry.object);
        t.equal(entry.dn.toString(), 'o=yunong, ' + REPL_SUFFIX);
      });

      res.on('error', function(err) {
        t.fail(err);
        t.end();
      });

      res.on('end', function(res) {
        t.end();
      });
    });
  });

  entryQueue.push(changelog);
});

test('push add changelog with unmatched filter', function(t) {
  // no uid field.
  var changelog = {
    object: {
      dn: 'changenumber=1326414273440, cn=changelog',
      controls: [],
      targetdn: 'foo=bar, o=yunong',
      changetime: '2012-01-13T00:24:33Z',
      changenumber: '1326414273443',
      changetype: 'add',
      changes: {
        objectclass: ['organizationalUnit'],
        ou: ['users'],
        l: ['somewhere']
      },
      objectclass: 'changeLogEntry'
    }
  };

  entryQueue.on('popped', function() {
    localClient.search('foo=bar, o=yunong', {filter: '(l=*)'},
                                   function(err, res) {
      t.ok(res);
      res.on('searchEntry', function(entry) {
        t.fail();
      });

      res.on('error', function(err) {
        t.ok(err);
        t.end();
      });
    });
  });

  entryQueue.push(changelog);
});

test('setup child entry', function(t) {
  localClient.add('cn=supsons, o=yunong', { objectclass: ['user'] },
                  function(err, res) {
    if (err) {
      t.fail(err);
      t.end();
    }
    t.ok(res);
    t.end();
  });
});

test('setup child entry', function(t) {
  var entry = {
    objectclass: ['user'],
    uid: uuid()
  };

  localClient.add('cn=supson, o=yunong', entry, function(err, res) {
    if (err) {
      t.fail(err);
      t.end();
    }
    t.ok(res);
    t.end();
  });
});

test('push delete changelog dn doesn\'t match', function(t) {
  console.log('entering delete changelog dn dne');
  var changelog = {
    object: {
      dn: 'changenumber=1326414273441, cn=changelog',
      controls: [],
      targetdn: 'cn=foobar, o=yunong',
      changetime: '2012-01-13T00:24:33Z',
      changenumber: '1326414273444',
      changetype: 'delete',
      objectclass: 'changeLogEntry'
    }
  };

  entryQueue.on('popped', function() {
    replicator.checkpoint.get(function(cp) {
      t.equal(true, cp == changelog.object.changenumber);
      t.end();
    });
  });

  entryQueue.push(changelog);
});

test('push delete changelog filter doesn\'t match', function(t) {
    var changelog = {
      object: {
        dn: 'changenumber=1326414273441, cn=changelog',
        controls: [],
        targetdn: 'cn=supsons, o=yunong',
        changetime: '2012-01-13T00:24:33Z',
        changenumber: '1326414273445',
        changetype: 'delete',
        objectclass: 'changeLogEntry'
      }
    };

    entryQueue.on('popped', function() {
      replicator.checkpoint.get(function(cp) {
        t.equal(true, cp == changelog.object.changenumber);
        t.end();
      });
    });

    entryQueue.push(changelog);
});

test('push delete changelog', function(t) {
  console.log('push delete changelog');
  var changelog = {
    object: {
      dn: 'changenumber=1326414273450, cn=changelog',
      controls: [],
      targetdn: 'cn=supson, o=yunong',
      changetime: '2012-01-13T00:24:33Z',
      changenumber: '1326414273450',
      changetype: 'delete',
      objectclass: 'changeLogEntry'
    }
  };

  entryQueue.on('popped', function() {
    localClient.search('cn=supson, o=yunong, ' + REPL_SUFFIX,
                                   {filter: '(uid=*)'},
                                   function(err, res) {
      if (err) {
        t.fail(err);
        t.end();
      }

      t.ok(res);
      // entry should not exist
      res.on('searchEntry', function(entry) {
        t.fail(entry);
        t.end();
      });

      res.on('error', function(err) {
        t.equal(err.code, 32);
        t.end();
      });
    });
  });

  entryQueue.push(changelog);
});

tap.tearDown(function() {
  process.exit(tap.output.results.fail);
});
