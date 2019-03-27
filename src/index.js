const {
  BaseKonnector,
  requestFactory,
  saveFiles,
  log
} = require('cozy-konnector-libs')
const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true
})

const VENDOR = 'ecoledirecte'
const baseUrl = 'https://www.ecoledirecte.com'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password, fields)
  log('info', 'Successfully logged in')
}

async function authenticate(identifiant, motdepasse, fields) {
  let { token, data } = await request.post(
    'https://api.ecoledirecte.com/v3/login.awp',
    {
      form: {
        data: JSON.stringify({ identifiant, motdepasse })
      }
    }
  )

  const result = await request.post(
    'https://api.ecoledirecte.com/v3/Eleves/9090/cahierdetexte/2019-03-11.awp?verbe=get&',
    {
      form: {
        data: JSON.stringify({ token })
      }
    }
  )

  token = result.token

  const fichier = result.data.matieres.find(
    doc => doc.matiere === 'PHYSIQUE-CHIMIE'
  ).aFaire.documents[0]

  await saveFiles(
    [
      {
        fileurl: 'https://api.ecoledirecte.com/v3/telechargement.awp?verbe=get',
        filename: fichier.libelle,
        requestOptions: {
          method: 'POST',
          form: {
            token,
            leTypeDeFichier: fichier.type,
            fichierId: fichier.id,
            anneeMessages: ''
          }
        }
      }
    ],
    fields,
    {
      requestInstance: request
    }
  )
}
